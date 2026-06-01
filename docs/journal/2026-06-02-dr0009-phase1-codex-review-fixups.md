# 2026-06-02: DR-0009 Phase 1 codex review 反映 (補強コミット)

## 達成

Phase 1 commit (3153bf5) に対して codex adversarial review を実施 → CRITICAL 2 件 + CONCERN 4 件を即修正。

review 全 12 件の評価結果:

| #      | 観点                                 | 評価         | 対応                                                                     |
| ------ | ------------------------------------ | ------------ | ------------------------------------------------------------------------ |
| 1      | redact-pipeline 責務分離             | MINOR        | Phase 7 で意味付与予定、現状維持                                         |
| 2      | 多層 redact 防御                     | CONCERN      | meta.project 経路を追加対応 (= #3 と統合)                                |
| 3      | chmod 新規ファイルのみ方針           | CONCERN      | kawaz 判断確定、journal の文言を整合 (queue.db は idempotent chmod する) |
| 4      | frontmatter YAML escape              | CONCERN      | round-trip は仕様外、escape 構造破壊防止が主目的の設計判断維持           |
| 5      | redact pattern カバレッジ            | CONCERN      | Phase 7 で実施明示、現状維持                                             |
| 6      | CSA spawn env 全送                   | **CRITICAL** | **Phase 7 前倒し、allowlist 化**                                         |
| 7      | テストカバレッジ不足                 | CONCERN      | chunked / \_rejected テスト追加                                          |
| 8      | DR-0009 Phase 1 スコープ             | CONCERN      | meta.project の article prompt 経路を追加対応                            |
| 9      | Phase 3 前方互換性                   | OK           | 構造維持で問題なし                                                       |
| 追加 1 | chunked synthesis section raw 再送信 | **CRITICAL** | section LLM 出力を redactForPrompt 経由に                                |
| 追加 2 | logger object ネスト未対応           | CONCERN      | sanitizeLogPayload 再帰化                                                |
| 追加 3 | queue.db-wal / -shm 未 chmod         | CONCERN      | applyMigrations 後に chmod (存在チェック付き)                            |

## 実装 (CRITICAL 2 件)

### CRITICAL #1: CSA spawn env allowlist (= 追加発見 6)

`Bun.spawn` で CSA を起動する際、`env: { ...process.env }` を渡していた。CSA は
session JSONL の読み取りしかしないが、`ANTHROPIC_API_KEY` / `GH_TOKEN` /
`SSH_AUTH_SOCK` / 1Password sock 等が全て CSA からアクセス可能だった
(= redact pipeline は子プロセス env に効かない)。

対応:

- 新規 `src/lib/spawn-env.ts` に `buildCsaEnv()` を実装、allowlist で env を絞る
- allowlist: HOME / PATH / USER / LOGNAME / TMPDIR / XDG*\* / LANG / LC*\* / TZ /
  CLAUDE_CONFIG_DIR (テスト隔離用)
- `spawn-timeout.ts:spawnWithTimeout` に `env?` opts を追加 (default は process.env、CSA 経路だけ buildCsaEnv を渡す)
- 適用箇所: `session-process.ts:483, 687` (timeline / sessions spawn) と `conversation.ts:176` (runCsaSessions)
- `claude-runner.ts` (claude CLI 起動) は `ANTHROPIC_API_KEY` 必須なので env 全送のまま保持
- テスト: `spawn-env.test.ts` で allowlist の対象 / 非対象 env を検証 (7 件)

### CRITICAL #2: chunked synthesis prompt の section redact (= 追加発見)

`processChunked` の synthesis 段階で、`orderedResults` (= section LLM 出力) が
`buildSynthesisPrompt` に raw で渡されていた。LLM が transcribe / hallucinate
した secret が synthesis LLM に再送信される穴。

対応:

- `orderedResults.map(redactForPrompt)` で先に redact してから buildSynthesisPrompt に渡す
- テスト: section LLM が `ghp_...` 含む output を返す mock、synthesis prompt を capture して redact されることを検証

## 実装 (CONCERN 4 件)

### CONCERN #3: meta.project を article-generation prompt で redact (= review 観点 2 + 8)

`processChunked` 内 `sessionInfo` と single-pass の `## セッション情報` ブロックで
`meta.project` (= session cwd 由来) が raw で埋め込まれていた。dispatcher prompt は
Phase 1 で redact 済だったが、article 生成側を忘れた。

対応:

- chunked path: `const projectSafe = redactForPrompt(meta.project || "unknown");`
- single-pass path: 同じ修正を追加
- テスト: meta.project に AKIA を仕込み、section / synthesis prompt 両方で redact されることを検証

### CONCERN #4: sanitizeLogPayload 再帰化 (= 追加発見 2)

logger は top-level string のみ redact、ネスト object はそのまま `JSON.stringify`。
`log({ meta: { stderr: token } })` のような future caller は漏れる。

対応:

- `sanitizeValue` を再帰関数として導入、object → 再帰、array → 各要素を再帰、string → redactForLog
- `DANGEROUS_FIELDS` も階層問わず drop
- テスト: ネスト object の string redact、ネスト DANGEROUS_FIELDS drop、array 内 string redact (各 1 件)

### CONCERN #5: queue.db-wal / queue.db-shm chmod (= 追加発見 3)

WAL モード有効化で `queue.db-wal` / `queue.db-shm` が生成されるが、本体 (queue.db)
だけ 0600 chmod、WAL/SHM はデフォルト権限のまま。

対応:

- `queue-internal.ts:getDb` と `rate-limit-store.ts:getDb` の applyMigrations 後に
  `chmodIfExists(${dbPath}-wal, 0o600)` と `chmodIfExists(${dbPath}-shm, 0o600)`
- `chmodIfExists` は ENOENT を ignore (= 完全 empty 状態では WAL 未生成)
- テスト: applyMigrations 後の WAL/SHM の mode を検証 (存在時のみ)

### CONCERN #6: chunked path / \_rejected path のテスト追加 (= review 観点 7)

`accepted` output のテストは Phase 1 で追加済だったが、(a) chunked synthesis 経路、
(b) `_rejected/` 経路は未検証。

対応:

- `processChunked` の unit test で chunked synthesis prompt が section LLM 出力を redact することを検証
- `processChunked` の unit test で meta.project に secret 含む場合 section / synthesis 両方で redact されることを検証
- `processSession` の e2e で `_rejected/` 経路の output redact + file mode 0600 + dir mode 0700 を検証

## 保留 (= 仕様判断 / Phase 範囲確定)

| #   | 観点                                      | 判断                                                                                                                                                |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | redact-pipeline 過剰分割                  | Phase 7 で `redactForPrompt` 専用 filter 追加予定、現状の名前分離は移行コスト削減の前向き設計                                                       |
| 3   | 既存ファイル遡及 chmod                    | kawaz 判断「新規分のみ」確定済、攻撃面縮小は新規書き込みからで十分                                                                                  |
| 4   | frontmatter parse は escape decode しない | 設計判断: frontmatter は short metadata 想定、round-trip 完全性は捨てた、構造破壊防止が主目的 (journal `2026-06-01-dr0009-phase1-security.md` 参照) |
| 5   | redact pattern Phase 7 defer              | DR-0009 Phase 7 で明示、現状維持                                                                                                                    |

## ハマり所

- 最初 `processChunked` の `_runClaudeOverride` 経由テストを追加した際、Phase 1 で
  oxlint 警告対応で削除した `redactForPrompt` import を再追加し忘れて 14 件 fail。
  redactForPrompt は今回の補強で再利用するため再 import。

## 検証

- bun test: 全 pass (補強で追加 14 件含む合計 808 件)
- bunx tsc --noEmit: clean
- bun test --isolate: 全 pass

新規追加テスト:

- `spawn-env.test.ts`: 7 件
- `logging.test.ts`: 3 件 (ネスト object / array)
- `queue.test.ts`: 1 件 (WAL/SHM mode)
- `session-process.test.ts`: 3 件 (chunked synthesis / meta.project chunked / \_rejected)

## 関連

- 起点: `docs/journal/2026-06-01-dr0009-phase1-security.md` (Phase 1 本体)
- review: codex adversarial review 経由 (`/codex:adversarial-review` 相当を `codex:codex-rescue` subagent で実行)
- 残課題: Phase 7 で redact pattern 拡充 + redactForPrompt 専用 filter
