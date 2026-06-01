# 2026-06-02: DR-0009 Phase 3+4+5 (本命解体) 進行中

## ゴール

DR-0009 Phase 3+4+5 を 1 つの commit チェーンで完遂する。

| Phase | 内容                                           | 進捗   |
| ----- | ---------------------------------------------- | ------ |
| 3     | processSession 解体 + DI 統一 + commands 縮退  | 進行中 |
| 4     | test 責務分離 (session-process.test.ts 分割等) | 未着手 |
| 5     | lib/ 副ディレクトリ化                          | 未着手 |

kawaz 判断 (2026-06-02 確認):

- 解体粒度: **Agent A 案** (lib/session-worker/ 6 files + lib/driver/ 4 files)
- lib/csa.ts: **Phase 3 で同時導入**
- Phase 3+4+5: **同 PR チェーン**

## 進行ログ

### Step 3-a: lib/csa.ts 新設 + CSA 関連集約 ✓

CSA (claude-session-analysis) ドメインを 1 ファイルに集約。

**移した関数 (lib/csa.ts、282 行)**:

- `csaBin` 定数
- `CsaSessionRecord` 型 + `CsaTimelineError` (新規)
- `runCsaSessions(ids)` (= 旧 conversation.ts)
- `getSessionMeta` / `getSessionMetaBatch` (= 旧 conversation.ts)
- `getSessionStats(sessionId, logKey)` (= 旧 `fetchSessionStats`、`run*`/`fetch*` を `get*` に統一)
- `countTimelineSeparators` / `isValidCsaTimeline` (= 旧 session-process.ts)
- `getSessionTimeline(sessionId, opts?)` (= 新規、`csa timeline --md --no-emoji` を集約)

**caller 更新**:

- `conversation.ts`: 135 行に縮退 (308 → 135)。`extractConversation` + `formatConversationToText` のみ
- `session-process.ts`: csa.ts import に統一、`getSessionStats` 名前変更追随
- `session-convert.ts` / `session-list.ts` / `session-enqueue.ts`: csa.ts 経由に
- `article-list.ts`: 重複 Bun.spawn 直叩きを `runCsaSessions` (csa.ts) 経由に統合

**buildCsaEnv() を全 CSA spawn に渡す** (= Phase 1 補強で確定した env allowlist を維持)

**test 更新**:

- `conversation.test.ts`: getSessionMeta 系 9 テスト → csa.ts 経由
- `session-process.test.ts`: 動的 import 3 箇所 + isValidCsaTimeline 系 5 テスト → csa.ts 経由

**検証**: bun test (822 pass) / bunx tsc --noEmit (clean) / oxlint (clean) / oxfmt (clean)

### Step 3-b: lib/recipe.ts に findRecipeByName + loadRecipesOrFail + matchesRecipe 統合 (未着手)

### Step 3-c: lib/session-worker/ 6 ファイル分解 (未着手)

### Step 3-d: lib/driver/ 4 ファイル分離 (未着手)

### Step 3-e: LLM DI シーム統一 (`_runClaude?: ClaudeRunner` 全箇所) (未着手)

### Step 3-f: mock.module("../lib/claude-runner.ts") 全 4 箇所撤去 (未着手)

### Step 3-g: commands/session-\*.ts を define() ラッパー ~30 行に縮退 (未着手)

### Step 3-h: run\* 命名再編 (runDispatcher → decideDispatch 等) (未着手)

### Phase 4: test 分割 (未着手)

- `session-process.test.ts` (現状 1240 行) を 5 ファイル分割
- `queue.test.ts` (現状 1205 行) を 3 ファイル分割
- 共通 helper (`createSessionFile`) を `test-fixtures.ts` の `writeSessionFixture` に統合

### Phase 5: lib/ 副ディレクトリ化 (未着手)

- `lib/queue/` / `lib/rate-limit/` / `lib/csa/` / `lib/claude/` / `lib/recipe/` /
  `lib/article/` / `lib/service/` / `lib/session-worker/` (Phase 3 で新設済) /
  `lib/driver/` (Phase 3 で新設済)
- import 全件追従

## 関連

- DR-0009 Phase 3 / 4 / 5 セクション
- 起点: `docs/journal/2026-06-01-zero-base-review-results.md`
- 前回完了: `docs/journal/2026-06-02-dr0010-claude-cmux-msg-pattern.md` (= 横道で
  install フロー整理完了)
