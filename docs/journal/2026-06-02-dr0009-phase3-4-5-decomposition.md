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

### Step 3-b: lib/recipe.ts 統合 ✓

recipe 関連を 1 ファイル集約、recipe-matcher.ts を廃止。

**統合後 lib/recipe.ts (112 行) export**:

- `parseRecipe(filePath)` (= 既存)
- `loadRecipes(recipesDir)` (= 既存)
- `loadRecipesOrFail()` (= session-process.ts から移植)
- `findRecipeByName(recipes, name)` (= session-process.ts から移植)
- `matchesRecipe(recipe, session)` (= recipe-matcher.ts から移植)

**削除**:

- `src/lib/recipe-matcher.ts`
- `src/lib/recipe-matcher.test.ts`
- `session-process.ts` 内の `findRecipeByName` / `loadRecipesOrFail` 定義 + 末尾の
  `export { findRecipeByName }`
- `session-process.ts` の不要 import (`loadRecipes` / `getRecipesDir` / `CliError`)

**caller 更新**:

- `session-process.ts`: matchesRecipe を recipe.ts 経由に
- `session-convert.ts`: import を 2 行分割 (findRecipeByName/loadRecipesOrFail は
  recipe.ts、processSession のみ session-process.ts)
- `session-enqueue.ts`: matchesRecipe を recipe.ts 経由 (loadRecipes と同じ行に統合)

**test 統合**:

- recipe-matcher.test.ts の matchesRecipe describe (11 件) を recipe.test.ts に追記
- 新規 findRecipeByName describe (3 件: 一致 / 不一致 / 空配列)
- 新規 loadRecipesOrFail describe (3 件: 1+ recipe / 空 dir / 不在 dir)
- XDG_CONFIG_HOME を tmpdir で isolate

**検証**: bun test (828 pass、+6) / bunx tsc --noEmit (clean) / just check (全 pass)

**ハマり所**:

- loadRecipesOrFail の元仕様コメント「0 recipe で throws」と実装が不一致 (実装は
  `[]` を返す)。実装どおりの挙動でテスト化、Design rationale コメント付き

### Step 3-c: lib/session-worker/ 分解 ✓

session-process.ts の "ライブラリ的責務" を `lib/session-worker/` 配下に分解。
advisor 助言で 6 ファイル予定 → **7 ファイル** に (cycle 回避のため leaf `worker-observation.ts` を追加)。

**新規ファイル**:

| File                     | Lines | Main exports                                                                         |
| ------------------------ | ----- | ------------------------------------------------------------------------------------ |
| `index.ts`               | 289   | `processSession`, `ProcessSessionInput`, `ProcessSessionResult`                      |
| `chunked-runner.ts`      | 196   | `processChunked`                                                                     |
| `prompt-builder.ts`      | 65    | `buildSectionPrompt`, `buildSynthesisPrompt`                                         |
| `fork-timeline.ts`       | 47    | `trimTimelineForFork`                                                                |
| `persistence.ts`         | 43    | `persistAccepted`, `persistRejected`                                                 |
| `frontmatter-builder.ts` | 41    | `buildFrontmatter`                                                                   |
| `worker-observation.ts`  | 25    | `recordWorkerObservation` (= cycle 回避用 leaf、index + chunked-runner の両方が依存) |

**session-process.ts: 850 → 231 行 (-619)**

残った 231 行: imports + re-export block + runProcess driver + runDispatcherEntry
driver + 関連型 + define() default export。driver 系は step 3-d で別途分離。

**re-export で test 互換性維持** (= session-process.test.ts は無変更で動く):

- `processSession`, `ProcessSessionInput`, `ProcessSessionResult`
- `buildSectionPrompt`, `buildSynthesisPrompt`
- `trimTimelineForFork`
- `processChunked`

**Phase 1 防御層を persistence.ts に集約**:

- `redactForOutput` を `persist()` 内 1 箇所で呼ぶ (= accepted / rejected 両方の経路で
  共通化、idempotent なので重複呼び出しは無害)
- `mkdir({ mode: 0o700 })` も `persist()` 内
- `chmod 0o600` も `persist()` 内、accepted / rejected 統一

**processSession 自体は ~180 行で停止** (= advisor 助言で過剰分割を避けた)。
~40 行目標は守れなかったが、責務は適切に外出しできており、これ以上の分割は
"凝集した orchestrator" を fragment するだけと判断。

**検証**: bun test (828 pass、+0) / bunx tsc --noEmit (clean) / just check (全 pass)。
oxfmt 1 回 auto-fix (chunked-runner + session-process)。

**ハマり所**: 当初 6 ファイル予定だったが `recordWorkerObservation` が
`session-process.ts ↔ session-worker/index.ts ↔ chunked-runner.ts` の循環を生む。
advisor 助言通り `worker-observation.ts` を leaf として切り出し、cycle 回避。

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
