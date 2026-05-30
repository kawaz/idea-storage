# 2026-05-30: DR-0008 Phase 2 PR③ 完成 — dispatcher (二段キュー)

## 達成

DR-0008 Phase 2 を完成。enqueue を「session 単位で `(session, 'dispatcher')` を 1 件 queued」に二段化、dispatcher worker が LLM で recipe を選別して採用分を enqueueBatch、不採用分を `markSkipped(dispatcher_rejected, lineCount=N)` で記録する形に。

- `bun test`: 745 pass / 0 fail (PR② 時 736 → +9: dispatcher.test.ts 8 + queue.test.ts 1)
- `bunx tsc --noEmit`: clean
- 新規ファイル: `src/lib/dispatcher.ts`, `src/lib/dispatcher.test.ts`, `config-examples/dispatcher_prompt.md`

## 主要な設計判断

### 1. dispatcher は internal sentinel な recipe 名

`"dispatcher"` を `DISPATCHER_RECIPE_NAME` 定数で export。`recipe-dispatcher.md` ファイルは作らず、user-facing recipe ローダ (`loadRecipes`) には含めない。

理由:

- queue_entries は `recipe_pk` (FK to recipes table) を持つので、`(session, "dispatcher")` を表現するために recipes に "dispatcher" 行が必要 → これは getOrCreateRecipePk が自然に作る
- recipe-\*.md ファイルにすると「ユーザが editable な recipe」と紛らわしい
- dispatcher prompt はユーザが上書きしたい場合があるので、`configDir/dispatcher_prompt.md` に置く (recipe-\*.md とは別経路)

不採用案:

- 「recipe-dispatcher.md として配布」: ユーザが誤って削除/編集する事故と、recipe loader の特別扱いコードが必要になるトレードオフ
- 「queue_entries に recipe_pk を NULL 許容にして dispatcher 行を表現」: schema 変更コストと既存クエリの影響

### 2. recipe.frontmatter `hint:` キー

DR-0008 §7 のとおり frontmatter に 1 行任意フィールド `hint:` を追加。dispatcher プロンプトで「向き・不向き」の判断材料として LLM に渡す。記載なしの recipe は `(no hint)` として「判断不能 = recall 重視で採用候補」扱い。

### 3. dispatcher プロンプトの外部化 + default fallback

`getDispatcherPromptPath()` → `configDir/dispatcher_prompt.md` を返す。ファイルが存在しない場合は `src/lib/dispatcher.ts` 内の `DEFAULT_DISPATCHER_PROMPT` を使う。雛形は `config-examples/dispatcher_prompt.md`。

理由:

- ユーザがプロンプトを差し替えられる柔軟性
- 配布時の最小コストで動く (config-examples/ をコピーしなくても default で動く)

### 4. 異常系の判別: transient (retry) vs structural (fallback)

DR-0008 §6 の通り:

- **transient** (API timeout / spawn error / abort): `runDispatcher()` が throw → caller (`runDispatcherEntry`) が `markFailed` → DR-0007 既存の retry 機構 (24h × 3) に乗る
- **structural** (JSON parse 失敗、`recipes` キー欠落): `runDispatcher()` は `fallback: { reason: "json_parse_error" }` 付きの decision を返す。caller は全 recipe を accepted として扱い、dispatcher 自身は markDone

「同じ入力で再実行しても同じ失敗」を retry しないために structural failure はテキスト fallback。

### 5. `"recipes": []` は「書かない判断」として尊重

LLM が空配列を返したら、全 recipe を rejected (markSkipped(dispatcher_rejected)) で記録。後で session に追記があれば §5.1 ルール (PR③ で `dispatcher_rejected` を `REENQUEUABLE_SKIPPED_REASONS` に追加) で自動的に dispatcher を再発火させる。

### 6. 存在しない recipe 名は無視

LLM が「リストにない recipe 名」を返したら、その名前は accepted/rejected どちらにも入れず、`decisionMessage` の `unknown` フィールドに記録。warning ログ相当の情報を history に残す形。

### 7. matchesRecipe 通過済み recipe だけ LLM に渡す

dispatcher は matchesRecipe (project glob / minTurns / minAge の静的判定) を通過した user recipes だけを `recipes_available` として LLM に提示する。静的判定で除外できる recipe を LLM に判断させるのはトークンの無駄。

### 8. dispatcher の line_count 管理 → §5.1 ルールで再 dispatch

dispatcher 行も markDone 時に `line_count=meta.lineCount` を記録。後でセッションが伸びたら §5.1 (done, new > old → queued) でもう一度 dispatcher を queued に。これで「session 追記時の再 dispatch」が自動化される。

不採用案: 「dispatcher を毎回再 enqueue する」は LLM コストが膨大。

## ハマり所 → 解決策

### 1. session-enqueue.test.ts の mock.module から `DISPATCHER_RECIPE_NAME` が export されてない

`mock.module("../lib/queue.ts", ...)` で `DISPATCHER_RECIPE_NAME` を export していなかったため、session-enqueue.ts の import が `SyntaxError: Export named 'DISPATCHER_RECIPE_NAME' not found` で全 fail。

**解決**: mock module に `DISPATCHER_RECIPE_NAME: "dispatcher"` を追加。

**残課題**: 本質的には PR① の「mock 撤去方針」に反するため、session-enqueue.test.ts を実 queue.ts (tempDir DB) で動かす形に切替えるべき (PR②と同じ別 PR で対応推奨)。

### 2. PR② で書いた「skipped(dispatcher_rejected) → 触らない」テストが PR③ で反転

`REENQUEUABLE_SKIPPED_REASONS` に `dispatcher_rejected` を追加 → 既存テストが「触る (= queued 復帰)」を期待する形に書き換え。

**解決**: queue.test.ts の該当テストを「new > old → queued 復帰」「new == old → 触らない」の 2 テストに分割。

### 3. session-enqueue.test.ts の既存「diary 期待」テストが Phase 2 で破綻

Phase 2 で各 recipe ではなく dispatcher 1 件だけが enqueue されるため、「diary が enqueueCalls に入る」期待のテストがすべて壊れる。

**解決**: 6 件のテストを「dispatcher が enqueue される」「複数 session でも 1 件/session の dispatcher」に書き換え。

## キューフロー (Phase 2 後)

```
[session-enqueue]
  for each session:
    effectiveUserTurns == 0:
      for each matchesRecipe-passing recipe: markSkipped(no_effective_turn, lineCount=N)
    effectiveUserTurns >= 1 and at least one matchesRecipe passes:
      enqueueBatch [{ sessionId, recipeName: "dispatcher", lineCount: N }]
      (§5.1 rules apply: pre-existing dispatcher in done/skipped(dispatcher_rejected) with new > old → queued)

[session-process: dequeue → recipeName == "dispatcher"]
  runDispatcher: build prompt + LLM → JSON parse
    ↓
  enqueueBatch(accepted) + markSkipped(dispatcher_rejected)(rejected)
    ↓
  recordDispatchDecision(sessionId, json)
    ↓
  markDone(sessionId, "dispatcher", meta.lineCount)

[session-process: dequeue → recipeName != "dispatcher"]
  既存のレシピ処理フロー (processSession)
```

## 変更ファイル

10 ファイル:

| ファイル                               | 内容                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/dispatcher.ts`                | 新規。`runDispatcher()`, `loadDispatcherPrompt()`, fallback ロジック                                                         |
| `src/lib/dispatcher.test.ts`           | 新規。8 件の単体テスト (JSON 成功 / 空配列 / unknown / parse fail / 周囲テキスト抽出 / throw 伝播 / prompt 構築)             |
| `config-examples/dispatcher_prompt.md` | 新規。dispatcher prompt 雛形                                                                                                 |
| `src/lib/queue.ts`                     | `DISPATCHER_RECIPE_NAME` export、`REENQUEUABLE_SKIPPED_REASONS` に dispatcher_rejected 追加、`recordDispatchDecision()` 追加 |
| `src/lib/queue-internal.ts`            | `HistoryAction` に `dispatch_decided` 追加                                                                                   |
| `src/lib/paths.ts`                     | `getDispatcherPromptPath()` 追加                                                                                             |
| `src/lib/recipe.ts`                    | parseRecipe で `hint` を読む                                                                                                 |
| `src/types/index.ts`                   | `Recipe.hint?: string` 追加                                                                                                  |
| `src/commands/session-enqueue.ts`      | 二段化: dispatcher 1 件 queued                                                                                               |
| `src/commands/session-process.ts`      | `recipeName == "dispatcher"` 分岐 → `runDispatcherEntry()`                                                                   |
| `src/lib/queue.test.ts`                | dispatcher_rejected の遷移を queued 復帰側に書き換え + same-lineCount no-op テスト追加                                       |
| `src/commands/session-enqueue.test.ts` | mock 更新、dispatcher 期待に書き換え                                                                                         |

## 残課題

1. **session-process.test.ts に dispatcher 経路の統合テスト追加**: 現状 dispatcher.test.ts は `runDispatcher()` の単体テストのみ。session-process の dequeue → runDispatcherEntry の流れは未テスト
2. **session-enqueue.test.ts から queue.ts mock 撤去**: PR① の「mock 撤去方針」との整合
3. **品質ガード (Phase 3)**: 出力 LLM 判定 + `_rejected/` 退避 + `inject_recent` (DR-0008 Phase 3)
4. **`session status` に skipped breakdown 追加**: DR-0008 §11 観測指標
5. **`claude_model` / `claude_version` を出力 frontmatter に追加**: DR-0008 §10

## 関連

- DR-0008 §6: dispatcher (二段キュー) の正本
- DR-0008 §7: recipe.hint の正本
- PR② journal: `docs/journal/2026-05-30-pr2-upsert-transition-rules.md`
- PR① journal: `docs/journal/2026-05-30-pr1-csa-fixture-migration.md`
