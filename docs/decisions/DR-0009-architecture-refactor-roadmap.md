# DR-0009: ゼロベースレビューに基づくアーキテクチャ・セキュリティリファクタリングロードマップ

## 背景

DR-0008 完了 (2026-05-30) 後、ユーザ指示で「差分修正の場当たり」から離れて**ゼロベースで全体を徹底レビュー**した。4 並列レビュー (A: 設計責務分離 / B: テスト品質 / C: アーキ・DR 整合 / D: セキュリティ) を実施 → 構造の根幹問題、セキュリティ脆弱性、DR との縮小実装、テスト責務肥大が浮上。

詳細な指摘の生はやや長いため、本 DR は「何をどの順序で、なぜ」のロードマップに徹し、各 Phase の詳細設計は **個別の新セッションで詰める**。発見の凝縮は `docs/journal/2026-06-01-zero-base-review-results.md` に集約済み。

## レビューの主要発見 (4 agent 統合、最重要のみ)

### 全 agent が一致する根幹問題

**`commands/session-process.ts` (889 行) が "コマンドファイル" を装った "アプリの中核オーケストレーション層"**:

- 内部に `processSession` (240 行の一枚岩)、`processChunked`、`runProcess`、`runDispatcherEntry`、`fetchSessionStats`、`loadRecipesOrFail`、`findRecipeByName`、`build*Prompt`、`trimTimelineForFork`、`isValidCsaTimeline` … が混在
- `commands/session-convert.ts` と `commands/session-run.ts` がここから import (= **command → command の逆方向結合**)
- これが (a) mock 完全撤去阻害、(b) output 経路の redact 欠落、(c) command 層が肥大、の **共通原因**

### 各 agent の独自重大発見

| Agent | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | LLM DI シーム 3 種混在 (`_runClaude(prompt)` vs `_runClaudeOverride(options)` vs **そもそも無い**) / CSA ドメインが `conversation.ts` と `session-process.ts` の 2 ファイルに分裂 / `run*` 命名がドライバと LLM ワーカーで二重化                                                                                                                                                                                                                    |
| B     | `mock.module("../lib/claude-runner.ts")` 4 箇所すべて processSession の DI 欠落起因 / `createSessionFile` が 3 ファイルで bespoke 重複、`writeSessionFixture` ヘルパが conversation.test.ts でしか使われてない / `src/types/index.test.ts` 104 行は型注釈の runtime 確認だけ (signal ゼロ)                                                                                                                                                          |
| C     | **1 DB ファイル × 2 schema 管理者**: `queue-internal.applyMigrations()` と `rate-limit-store.initSchema()` が同じ DB を独立に open。`rate_limits` だけ `user_version` 管理外 / DR-0008 §6 dispatcher 入力スキーマが縮小実装 (`turn_classification` / `size_bytes` / `duration_ms` を SessionMeta が保持してない) / `QueueDirs` 型は SQLite 移行後の死に体 (dirname 1 個に圧縮されてるだけ) / `paths.ts` `@deprecated` 3 関数が migrate-queue で現役 |
| D     | **redact が timeline 入力にのみ適用、output / log / frontmatter / inject_recent / dispatcher `raw_excerpt` (history.message) は無加工** / 出力 md・queue.db・state dir が mode 0644 (世界読み取り可) / CSA spawn に `{...process.env}` 全送 (ANTHROPIC_API_KEY 不要なのに渡してる) / `config.ts` の dynamic import は任意 TS コード実行サーフェス / frontmatter 値が String(value) で YAML エスケープなし / CI で CSA を SHA pin なし clone         |

## スコープ

本 DR は **複数 PR にまたがるリファクタリングのロードマップ**。各 Phase の詳細設計・粒度確定・実装は **個別の新セッション** で行う。本 DR の責務は:

1. Phase の切り方と順序を定める
2. 各 Phase の目的・対象・判断事項・検証基準を明示
3. 新セッション開始時の引き継ぎ起点となる

**スコープ外**:

- 各 Phase の具体的なファイル分割粒度 (ガイドラインは示すが、詳細は新セッションで詰める)
- Phase 6 の DR-0008 §6 amend vs 実装拡張の判断 (ユーザ確認必須)
- Phase 8 の運用整備の具体仕様 (CLAUDE.md / VERSION / CHANGELOG の中身)

## Phase 構成

### Phase 1: セキュリティ即応 (P0、独立着手可能)

**目的**: ユーザのセッション機密情報の漏出経路を遮断。Phase 3 と独立にすぐ動ける。

**該当**: Agent D の S1 / S2 / S3 + 細部 (frontmatter YAML エスケープ)

**対象**:

- `logging.ts:sanitizeLogPayload` を「全 string フィールドに `redactSecrets` + 長さ上限」に変更 (現状 `error` キーだけ)
- `processSession` の output / `runQualityGate` 入力 / `frontmatter` 文字列値 / `recent-outputs` body / dispatcher `raw_excerpt` (history.message) すべてに **`redactSecrets` を通すパイプライン化**
- `Bun.write` 出力直前と `Database` open 直後に **chmod 0600**、`getDataDir()` / `getStateDir()` 親作成時に **mode 0700**
- `_rejected/` も同様 (品質ゲートが落とした怪しい LLM 生文が最も漏らしたくない素材)
- `frontmatter.ts:generateFrontmatter` の値を YAML エスケープ (改行・コロン・引用)

**判断事項 (次セッションで確認)**:

- redact pipeline を集約する位置: 新規 `lib/redact-pipeline.ts` か `redact.ts` 拡張か
- 既存 output ファイルの権限変更は移行コマンドが必要か (chmod 0600 を `_rejected/` 含めて遡及するか)

**検証**: `bun test` pass + 新規追加 test で「stderr / output / frontmatter / inject_recent / dispatcher raw_excerpt に AKIA を仕込むと redact される」

**工数目安**: 1-2 日

---

### Phase 2: DB スキーマ単一権限化 (P0、Phase 1 と並行可能)

**目的**: 1 DB ファイルを 2 つの schema 管理者が独立に open している危険状態を解消。

**該当**: Agent C 問題② + 問題③ (毎回 open/close の重複)

**対象**:

- `rate-limit-store.ts:initSchema()` を **`queue-schema.ts:applyMigrations()` に統合**、`rate_limits` も `user_version` 管理下に入れる
- `rate-limit-store.getDb()` を廃止、`queue-internal.getDb()` を共有 (singleton 化検討)
- 既存 DB の `rate_limits` テーブルとの互換性確認 (現実装は `CREATE IF NOT EXISTS` なので既存テーブル温存)

**判断事項**:

- DB ファイル名を `queue.db` → `state.db` にリネームするか (DR-0004 で名付けたが、現状は queue 以外も入る)。**リネームは後方互換的に既存ユーザの DB を壊すので慎重**。本 Phase ではリネームしない方針推奨、後の DR で扱う
- `getDb()` を module-level singleton にするか、関数ごと open/close 維持か (前者は性能、後者は分離性)

**検証**: `bun test` pass + 既存 DB を破壊しない (migration 冪等性) + `migrate-queue` パスの回帰なし

**工数目安**: 半日

---

### Phase 3: processSession 解体 + DI 統一 + commands 縮退 (本命、Phase 1+2 後)

**目的**: 4 agent の主要指摘が同時消化される本命改造。これを終えれば残課題の大半が自然に解消する。

**該当**:

- Agent A: §3 解体プラン全体 (LLM DI 統一 + CSA ドメイン集約 + `run*` 命名再編)
- Agent B: P0 #1 (`_runClaude` DI 追加 → mock.module 撤去)、P0 #4 (`createSessionFile` 重複統合)
- Agent C: 問題① (commands/ がライブラリ化)
- Agent D: S2 (output 経路 redact) を新生 `persistence` モジュールで組み込み (Phase 1 の redact pipeline を呼ぶ層)

**対象** (Agent A の解体プランベース、命名は新セッションで確定):

- 新規 `lib/csa.ts` (or `lib/csa/`): `csaBin`、`getSessionTimeline`、`getSessionStats`、`getSessionMeta(Batch)`、`runCsaSessions`、`isValidCsaTimeline`、`countTimelineSeparators` を全部集約
- 新規 `lib/session-worker/`:
  - `index.ts` (`processSession` をオーケストレータ ~40 行に)
  - `prompt-builder.ts`
  - `fork-timeline.ts`
  - `chunked-runner.ts` (`processChunked` + `build*Prompt`)
  - `frontmatter-builder.ts`
  - `persistence.ts` (quality gate + `_rejected/` + Phase 1 の redact pipeline 適用点)
- 新規 `lib/driver/`:
  - `process-driver.ts` (`runProcess`)
  - `convert-driver.ts` (`runConvert`)
  - `enqueue-driver.ts` (`runEnqueue`)
  - `dispatcher-entry.ts` (`processDispatcherEntry`, 旧 `runDispatcherEntry`)
- `lib/recipe.ts` に `findRecipeByName` / `loadRecipesOrFail` / `matchesRecipe` 統合 (`recipe-matcher.ts` 廃止)
- **LLM DI シーム統一**: 全箇所 `_runClaude?: ClaudeRunner` (= `(options: ClaudeRunOptions) => Promise<string>`) で受ける。`processSession` の single-pass にも DI 経路を追加
- `commands/session-{process,convert,enqueue}.ts` を `define()` ラッパー ~30 行に縮退
- `mock.module("../lib/claude-runner.ts")` 全 4 箇所を撤去、test は `_runClaude` 注入で代替
- `run*` 命名再編: `runDispatcher` → `decideDispatch`、`runQualityGate` → `judgeQuality`、`runDispatcherEntry` → `processDispatcherEntry`

**判断事項**:

- 解体の粒度 (Agent A は session-worker を 6 ファイルに、Agent C は workflows/ で 3-4 ファイルに分ける案 → 新セッションで decide)
- ディレクトリ命名: `lib/workflows/` (Agent C) vs `lib/session-worker/` + `lib/driver/` (Agent A) → 後者推奨 (driver と worker の責務が明示される)
- 命名再編で生まれる旧名の deprecated 期間 (公開 API ではないので即削除可)
- `lib/csa.ts` を Phase 3 内でやるか Phase 5 (副ディレクトリ化) と一緒にやるか

**検証**: `bun test` pass (現状 759 件) + `bun test --isolate` でも pass + typecheck clean + `commands/` の各ファイルが 50 行以下 + `mock.module` の出現箇所が **0**

**工数目安**: 3-5 日

---

### Phase 4: テスト責務分離 (Phase 3 とほぼ同 PR を推奨)

**目的**: Phase 3 で production が分かれる → test も対応して分割しないと意図が逆乖離する。

**該当**: Agent B の P1 #2 / #3 / #4 / #5 + カバレッジ穴埋め

**対象**:

- `session-process.test.ts` (1240 行) を Phase 3 の解体に合わせて **6 ファイル分割** (Agent B 案):
  - `session-process.test.ts` (run-process driver の E2E)
  - `session-process.prompts.test.ts` (build\* helper)
  - `session-process.chunked.test.ts`
  - `session-process.timeline.test.ts` (trimTimelineForFork + isValidCsaTimeline + countTimelineSeparators)
  - `session-process.session.test.ts` (processSession 本体 fork-guard / redact / empty)
- `queue.test.ts` (1205 行) を **`queue.test.ts` (write API) / `queue-state.test.ts` / `queue-schema-migration.test.ts` に分割**
- `createSessionFile` の 3 ファイル bespoke 重複を `writeSessionFixture` に統合 (test-fixtures に追加 opts)
- `src/types/index.test.ts` 104 行 **全廃** (型注釈の runtime 確認だけで signal ゼロ)
- `ProcessResult type includes expected values` 削除
- 緩い assertion 厳密化: `runClaudeCalls.length >= 1` → `toBe(N)` 等、deterministic 化可能なものを厳密に
- **欠落カバレッジ追加**:
  - `runDispatcherEntry` の dequeue 経由 e2e (dispatcher.test.ts は `runDispatcher` 単体のみ)
  - `quality_gate rejected → _rejected/` への退避 e2e (filesystem 検証)
  - `fetchSessionStats` (Phase 3 で `getSessionStats` 化される CSA spawn)
  - `recordWorkerObservation` の DB 失敗 swallow path

**判断事項**:

- Phase 3 と同 PR に含めるか別 PR にするか (推奨: 同 PR、production と test の意図が乖離しない)

**検証**: 各 test ファイル 500 行以下 + `bun test` 全件 pass + 新規 e2e カバレッジ追加分が pass

**工数目安**: 2 日 (Phase 3 と並行作業すれば吸収可能)

---

### Phase 5: lib/ 副ディレクトリ化 (Phase 3 完了後、推奨は Phase 3/4 と同 PR)

**目的**: フラット 70+ ファイルから「ドメイン境界が見える」構造へ。

**該当**: Agent A §4-D、Agent C §3

**対象** (Agent C 案ベース):

- `lib/queue/` (queue.ts, queue-internal.ts, queue-schema.ts, queue-state.ts, migrate-queue.ts)
- `lib/rate-limit/` (rate-limit-{judge,parser,store}.ts)
- `lib/csa/` (Phase 3 で生まれる csa.ts, conversation.ts, session-jsonl.ts, session-finder.ts)
- `lib/claude/` (claude-runner.ts, claude-meta.ts)
- `lib/recipe/` (recipe.ts (= recipe-matcher 統合済), dispatcher.ts, quality-gate.ts, recent-outputs.ts)
- `lib/article/` (article-format.ts)
- `lib/service/` (service.ts, plist.ts)
- `lib/session-worker/` (Phase 3 で新設)
- `lib/driver/` (Phase 3 で新設)
- `lib/` 直下 (真の横断): errors / logging / paths / config / constants / help / validate / format / dir-exists / lockfile / spawn-timeout / timeout-error / chunker / frontmatter / redact (+ Phase 1 の redact-pipeline)
- import 全件追従

**判断事項**:

- `lib/csa/` を Phase 3 で導入するか Phase 5 で動かすか
- Phase 3 + 4 + 5 を 1 PR にするか分割するか (1 PR だと import 追従 1 回で済むが、PR が巨大化)

**検証**: typecheck clean + `bun test` 全件 pass + ドメインごとのファイル一覧が 1 ディレクトリで把握できる

**工数目安**: 半日 (Phase 3 と同 PR なら吸収可能)

---

### Phase 6: DR 整合性 (Phase 3 完了後)

**目的**: Agent C のギャップ列を解消、DR と実装の整合を回復。

**該当**: Agent C §4

**対象**:

- **DR-0008 §6 dispatcher 入力スキーマの方針確定** (ユーザ判断必須):
  - 選択肢 A: DR を amend して「縮小実装が正」とする (`turn_classification` / `bytes` / `duration_ms` を入力に含めない方針を文書化)
  - 選択肢 B: SessionMeta に追加して dispatcher prompt にも反映 (DR 通り実装)
- DR-0008 §11 残課題 (last 30 days 窓 / dispatcher fallback rate / quality gate rejection rate / effective filter pass rate) を **`docs/issue/`** に切り出し、いつでも独立 PR で着手できる状態に
- DR-0008 末尾「mock 撤去は別 PR」記述を **resolved** に更新 (Phase 3 で完了するため)
- INDEX.md の DR-0008 行を「implemented + refactored on 2026-06-XX」等に更新

**判断事項**:

- §6 amend (A) vs 実装拡張 (B): dispatcher が現状 (= hint だけで判定) でも十分機能していると観察できれば A、観察できなければ B

**検証**: DR / INDEX / journal の整合 + ユーザの設計判断が記録に残る

**工数目安**: 半日 (判断含む)

---

### Phase 7: 横断レイヤと細部 (Phase 3 後、独立小 PR の連続)

**目的**: agent 全体の中重要度指摘の刈り取り。

**該当**: Agent A 中重要度、Agent C §5+§6、Agent D 細部

**対象** (小 PR に分割可能):

- `types/index.ts` colocate (Recipe → recipe.ts、SessionMeta → csa.ts、QueueEntry → queue.ts、ConversationMessage → conversation.ts、Config → config.ts)、`types/index.ts` 廃止
- `QueueDirs` 型廃止 + 全 queue 関数の signature 単純化 (dirs パラメータ削除、test fixture を env 切替に統一)
- `paths.ts` の `@deprecated` 3 関数を `migrate-queue.ts` 内 private に格下げ
- `validate.ts` と `queue-internal.ts` の 同名関数衝突解消 (rename: `assertCliRecipeName` / `validateStoredRecipeName` 等、意図を名前で区別)
- `errors.ts` の `exitWithError` 廃止、`CliError` 統一
- **redact pattern 拡充**: Slack token (`xox[abpr]-...`) / Stripe `sk_live_` / GCP service account key / OpenAI `sk-proj-` `sk-svcacct-` / generic `(API_)?KEY|SECRET|PASSWORD|TOKEN` env 名のゆるいマッチ
- **CSA spawn の env allowlist**: `ANTHROPIC_API_KEY` 等を CSA に渡さない (最小権限)
- `session-jsonl.ts` の 1 行サイズ上限ガード (悪意ある JSONL での OOM 対策)
- `config.ts` を JSON 化 (任意コード実行サーフェス削減)、または動的 import 維持なら uid check + ドキュメント明示
- CI workflow の 3rd-party action を **SHA pin** (`oven-sh/setup-bun@v2` → 特定 SHA、`actions/cache@v4` 同様、`extractions/setup-just@v3` 同様)
- CI の CSA clone を **SHA pin or git submodule** に
- `recent-outputs.ts` の prompt 注入のドキュメント警告 (N を大きくすると secrets 増幅リスク)
- `dispatcher` の `raw_excerpt` も Phase 1 の redact pipeline に通す
- `service-log.ts:47` の `lines` 数値型バリデーション

**判断事項**:

- 各小項目を 1 PR ずつにするか、テーマで束ねるか (例: 「型 colocate + QueueDirs 廃止 + paths cleanup」「security 細部一括」など)

**工数目安**: 計 2-3 日 (分割可能)

---

### Phase 8: 運用整備 (独立、いつでも着手可能)

**目的**: 新セッション・新規 contributor の onboarding 改善。kawaz のリリース慣習に整合。

**該当**: 私の独自観察 (CLAUDE.md 不在、VERSION 不在、CHANGELOG 古い)

**対象**:

- `CLAUDE.md` 新設 (プロジェクトコンテキスト、責務、build/test/push コマンド、外部依存 CSA の扱い)
- `VERSION` ファイル + `release.yml` 整備 (kawaz の `release-flow-awareness` rule に準拠、homebrew tap 配布フローに乗せる)
- `CHANGELOG.md` を DR-0008 含む最新まで更新

**工数目安**: 半日

## 進行順序 (依存関係)

```
Phase 1 (P0 security pipeline) ──┐
                                  ├──> Phase 3 (本命解体) ──┬─> Phase 4 (test 分割) ── 同 PR 推奨
Phase 2 (DB 単一化, P0) ──────────┘                          ├─> Phase 5 (lib/ subdir) ── 同 PR 推奨
                                                              ├─> Phase 6 (DR 整合)
                                                              └─> Phase 7 (横断細部、小 PR 連続)

Phase 8 (運用) — いつでも独立
```

## 不採用案

- **全部一気に大改造**: PR が巨大化、レビュー / 切り戻し困難。フェーズ分割が筋
- **現状維持**: ユーザの「ゼロベース見直し」指示に反する。脆弱性 (Phase 1) を放置するのも論外
- **Phase 1 と Phase 3 を統合**: Phase 1 (redact / chmod) は Phase 3 と独立に動けて、セキュリティが先に閉じる方が安全。並行が筋
- **Phase 4 を Phase 3 と別 PR にする**: production と test の意図が乖離するリスク、同 PR が筋
- **commands/ を維持したまま処理を `lib/` に移すだけ**: 命名 (`run*` の二重化など) と責務境界の問題が残る、命名再編まで通すのが筋

## リスク

| リスク                                                      | 対策                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Phase 3 で大規模 import 変更 → 中途半端な状態で他作業を中断 | 1 PR にまとめて push 前に typecheck + bun test + bun test --isolate を必ず通す |
| 既存 DB (`queue.db`) の互換性破壊 (Phase 2 / Phase 5)       | migration 冪等性テスト + 既存 DB を `dist/` 配下で再現してテスト               |
| `processSession` 解体 (Phase 3) で挙動退行                  | Phase 4 で e2e カバレッジを先に充実 → 解体前後で全 test 同一 pass              |
| redact pipeline (Phase 1) を全経路に通すと処理コスト増      | `redactSecrets` は idempotent + cache-able、measure して allowable             |

## ロールバック方針

各 Phase が main にマージ後の問題発覚時:

- Phase 1: 個別の redact 適用点を revert で個別解除可能
- Phase 2: migration を v2 → v1 に戻す逆 migration を用意 (新スキーマで作られた行が残る前提でテスト)
- Phase 3: import path の追従が膨大なので revert は 1 PR まるごとに。**部分 revert は禁則**
- Phase 5: ディレクトリ移動は 1 PR 単位で revert
- Phase 7 / 8: 小 PR 単位で個別 revert

## 新セッションへの引き継ぎ手順

各 Phase 開始時:

1. 本 DR-0009 を読む
2. journal `docs/journal/2026-06-01-zero-base-review-results.md` で 4 agent の発見を再確認
3. 該当 Phase の判断事項を kawaz に確認
4. 着手前に `bun test` / `bunx tsc --noEmit` が pass している状態を起点とする
5. 1 Phase = 1 PR (Phase 3+4+5 は同 PR 推奨) で進める
6. 完了後 `bun test --isolate` も pass 確認

## 関連

- DR-0008 (実装完了、本 DR の起点)
- journal `docs/journal/2026-06-01-zero-base-review-results.md` (4 agent 発見の凝縮版)
- 過去の journal 2026-05-30-pr1〜pr6, 2026-05-31-\* (DR-0008 各 PR の経緯)
- メモリ: `feedback_csa_jsonl_all_fields_optional` / `feedback_autonomous_mode_user_remote`
