# 2026-06-01: DR-0009 Phase 1 (security pipeline) 実装

## 達成

DR-0009 Phase 1 (P0 security) の S1 / S2 / S3 + 細部 (frontmatter YAML escape) を完了。

- 起点条件確立: `bun test` 786 件 + `bunx tsc --noEmit` clean + `bun test --isolate` 全 pass
- 完了条件: 同 3 種すべて pass、新規 33 件のテストを追加 (合計 794 件 pass)
- 編集ファイル:
  - 新規: `src/lib/redact-pipeline.ts`, `src/lib/redact-pipeline.test.ts`
  - 編集: `src/lib/logging.ts`, `src/lib/frontmatter.ts`, `src/lib/dispatcher.ts`,
    `src/lib/quality-gate.ts`, `src/lib/recent-outputs.ts`, `src/lib/queue-internal.ts`,
    `src/lib/rate-limit-store.ts`, `src/commands/session-process.ts`
  - テスト: `src/lib/logging.test.ts`, `src/lib/frontmatter.test.ts`, `src/lib/dispatcher.test.ts`,
    `src/lib/quality-gate.test.ts`, `src/lib/recent-outputs.test.ts`, `src/lib/queue.test.ts`,
    `src/lib/rate-limit-store.test.ts`, `src/commands/session-process.test.ts`

## 設計判断

### redact-pipeline は新規 `lib/redact-pipeline.ts` に分離

選択肢:

- A. 新規 `lib/redact-pipeline.ts` (採用)
- B. 既存 `redact.ts` を拡張

採用理由: `redact.ts` は低レベル primitive (パターン定義 + `redactSecrets` 関数) のまま保ち、
pipeline は「**どこに送るデータか**」を意図として表現する高レベル層に分離。call site で
`redactForOutput(body)` と書けば "this body is about to hit a file on disk" が明示できる。
Phase 3 で `lib/session-worker/persistence.ts` から呼ばれる前提で、関数 signature を
意図別に分けたほうが Phase 3 の解体時に責務が明確になる。

### 3 つの意図別関数 (redactForLog / redactForOutput / redactForPrompt)

すべて `string → string` の純粋関数。非 string ガードは call site の責務 (例: logging.ts は
`typeof value === "string"` で絞ってから渡す)。

- `redactForLog`: cap (default 500 chars) — ログは観測信号、診断キャプチャでない
- `redactForOutput`: no cap — 出力本文は完全保持
- `redactForPrompt`: no cap — LLM 入力は情報密度を保持

`redactForOutput` と `redactForPrompt` は今は同一実装だが、Phase 7 で prompt 専用 filter
(例: API key 変数名そのものを drop) を追加できるよう関数を分離。

### chmod は新規分のみ (kawaz 判断、既存ファイルは遡及しない)

- `Bun.write` 後に `chmod(file, 0o600)` を発火
- `mkdir({ recursive: true, mode: 0o700 })` で新規 dir のみ owner-only
- DB ファイル (queue.db) は getDb() 毎回呼ばれるが chmod は冪等なので問題なし
- 既存 output / `_rejected/` / queue.db は touch しない

採用理由: kawaz の `AskUserQuestion` で「新規分のみ (Recommended)」を選択。
理由: シンプル、冪等、migration コード不要、攻撃面の縮小は新規書き込みからで十分。

### frontmatter YAML escape

`generateFrontmatter` の `String(value)` 直書きを `encodeYamlScalar` 経由に変更。

- 値を `redactForOutput` で先に redact (frontmatter は output の一部、再度全体に redact が
  かかっても idempotent)
- 安全な scalar (改行 / `:` / `"` / `'` / `\` / `#` 含まず、`---` でなく、前後空白なし) は
  そのまま出力
- 危険な scalar はダブルクオート + `\` / `"` / `\n` / `\r` / `\t` escape

frontmatter は短い metadata 想定なので、`\n` を literal 2-char に escape して single-line
化する。`parseFrontmatter` は escape sequence を decode しないが、frontmatter 構造破壊を
防ぐのが主目的なので OK。長文は body 側に書く運用前提。

### 多層防御を採用

- input redact: timeline / dispatcher project / hint
- output redact: `Bun.write` 直前の `redactForOutput(fm + output)` (defense in depth)
- quality-gate: 入力 `output` に再度 `redactForPrompt` (LLM が transcribe / hallucinate した
  secret を gate LLM 側で増幅させない)
- recent-outputs: 注入時に再度 redact (古い output の redact 漏れを次世代 prompt に持ち込まない)
- dispatcher raw_excerpt: history DB 永続化前に redact

各層で idempotent な redact が走る。CPU コストは小だが、層が抜けても他層で止まる構造。

## ハマり所

特になし。TDD で進めたため、テスト先行で signature を固めてから実装した。
回帰テストは 1 度も赤くならず、追加テストも一発 pass。

## 残課題 (Phase 3 以降に持ち越し)

### Phase 3 で吸収する点

- `lib/session-worker/persistence.ts` (Phase 3 新設予定) が Bun.write 直前の防御層 redact
  と chmod を集約する。現状は `commands/session-process.ts` 内に直接書いたが、Phase 3 で
  persistence module に移動する想定で関数 signature を意識した
- `lib/csa.ts` (Phase 3 新設) が CSA stderr redact を一手に引き受ける (現状は logger 経由で
  `redactForLog` が処理しているのみ)

### Phase 7 で扱う細部

- redact pattern 拡充 (Slack token / Stripe / GCP service account / OpenAI 新形式 / generic env)
- CSA spawn の env allowlist (現状 `{...process.env}` 全送)
- `session-jsonl.ts` の 1 行サイズ上限ガード
- `config.ts` の dynamic import 制限 (任意 TS 実行サーフェス)
- CI workflow の 3rd-party action SHA pin / CSA SHA pin

### Phase 2 (DB 単一化) との関係

- 現状 `queue-internal.ts` と `rate-limit-store.ts` の両方で chmod を発火 (同じ queue.db に
  対して。冪等なので無害)
- Phase 2 で getDb() を統合すると chmod も 1 箇所に集約される

## 検証エビデンス

各経路で「AKIA / ghp\_... を仕込むと redact される」テストを追加:

| 経路                                    | テストファイル                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| logging.ts 全 string field              | `logging.test.ts` (新規 3 件)                                                       |
| frontmatter 値 + YAML escape            | `frontmatter.test.ts` (新規 6 件)                                                   |
| quality-gate LLM 入力                   | `quality-gate.test.ts` (新規 1 件)                                                  |
| dispatcher project / hint / raw_excerpt | `dispatcher.test.ts` (新規 3 件)                                                    |
| recent-outputs body 注入                | `recent-outputs.test.ts` (新規 1 件)                                                |
| session-process Bun.write 防御層        | `session-process.test.ts` (新規 1 件、output file 内容 + mode 0600 + dir mode 0700) |
| queue.db file mode                      | `queue.test.ts` (新規 1 件)                                                         |
| rate_limit DB file mode                 | `rate-limit-store.test.ts` (新規 1 件)                                              |
| redact-pipeline 単体                    | `redact-pipeline.test.ts` (新規 16 件、idempotency / 長さ cap / 用途別)             |

合計 33 件追加、全 pass。

## 関連

- DR-0009 Phase 1 (本 journal の起点) — `docs/decisions/DR-0009-architecture-refactor-roadmap.md`
- ゼロベースレビュー結果 — `docs/journal/2026-06-01-zero-base-review-results.md`
- Phase 3 (本命解体) で `lib/session-worker/persistence.ts` 集約予定
- Phase 7 で redact pattern 拡充 + env allowlist + CI SHA pin
