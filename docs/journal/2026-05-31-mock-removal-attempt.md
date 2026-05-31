# 2026-05-31: session-enqueue.test.ts mock 撤去の試行と断念

## 達成

- DR-0008 完了マーク追記 (PR⑦, commit `bc7a00a9`) ← push 済み
- session-enqueue.test.ts から queue.ts mock を撤去する試行 ← 断念、revert

## 経緯

DR-0008 の残課題リストにあった「session-enqueue.test.ts から queue.ts mock 撤去」を
PR① の「mock は筋悪、契約は実機で検証」方針との整合のために実施しようとした。
方法論として:

- `src/lib/test-fixtures.ts` に `withIsolatedIdeaStorageEnv()` を追加
  (HOME / CLAUDE_CONFIG_DIR に加えて XDG_STATE_HOME / XDG_DATA_HOME も override)
- session-enqueue.test.ts を「実 queue.db を tempDir に作って実 queue.ts を呼ぶ」
  スタイルに全面書き直し
- mock.module("../lib/queue.ts", ...) を完全削除
- pre-seed ヘルパ (preSeed) と read ヘルパ (readEntries / readAllEntries) を新設

このセットで session-enqueue.test.ts 単独 (`bun test src/commands/session-enqueue.test.ts`)
は 19 件全 pass。`bunx tsc --noEmit` も clean。

## 詰まった所

`bun test` (全件) で 5 件 fail。原因: **`process.env` mutation が他テストファイルに漏れる**。

具体例:

- session-enqueue.test.ts の `withIsolatedIdeaStorageEnv(tempA)` 内で
  `XDG_STATE_HOME = tempA/state` を set
- そのテスト実行中に並列で別ファイル (例: session-convert.test.ts) が走る
- 別ファイル側のテストが queue.db を「prod 期待」で触ったつもりが tempA/state の DB に行く
  (or 逆方向)
- 結果: preSeed で `done(lineCount=5)` を書いたのに、runEnqueue 後の readEntries で
  `queued(lineCount=5)` を取得 (= §5.1 ルールでは触らないはずが、別 DB を読んでる
  ため期待と不一致)

`--parallel=1` でも、`--isolate` でも改善せず。`--isolate` は逆に
session-convert.test.ts / session-process.test.ts の **mock 不備が露呈** する
(PR③ / PR④ で paths.ts と queue.ts に追加された新 export を mock 側に反映してない:
`getDispatcherPromptPath` / `getQualityGuidelinesPath` / `getRejectedDir` /
`enqueueBatch` / `DISPATCHER_RECIPE_NAME` / `recordDispatchDecision` /
`getSkippedBreakdown` 等)。

## 断念の判断

mock 撤去の本格対応には以下が必要と判明:

1. **queue.ts の dirs パラメータを caller 側で常時明示**: session-enqueue.ts に
   `options.dirs` を追加し、env mutation に依存しないテストが書ける構造に
2. **isolate モード前提への切替**: justfile / CI で `bun test --isolate` をデフォルトに
3. **session-convert.test.ts / session-process.test.ts の mock 整理**: 新 export を
   全て mock 側に反映 (= PR③ / PR④ の漏れ)
4. **CI 時間とのトレードオフ**: isolate モードは各ファイルで JS context を立て直すので
   遅い (現状 ~5 秒 → 数倍に伸びる可能性)

このセッションのスコープを超えるため、別 PR/別セッションで設計から立て直すのが
ベスト判断。session-enqueue.test.ts と test-fixtures.ts の変更は `jj restore` で
revert、session-convert.test.ts も revert して clean state に戻す。

## 残課題 (再掲、優先順位付き)

1. **mock 整理のための設計議論**: queue.ts の dirs 引数化 vs env mutation
   持続 vs Bun.spawn による完全 isolated child process — どれが筋か。CI 時間も評価軸
2. session-convert.test.ts / session-process.test.ts の mock 不備修正
   (isolate モードで pass するように)
3. session-process.test.ts の dispatcher / quality gate / inject_recent 統合テスト
4. getSkippedBreakdown に時間窓フィルタ
5. DR-0009 (Phase 4): quality_guidelines.md 自動更新

## 補足: bun test の挙動メモ

- `--max-concurrency=20` がデフォルト (test 単位の並列度)
- `--isolate` はファイル毎に fresh global object、ハンドルリーク防止
- `--parallel=N` は N worker process でファイル並列
- 既存テストは `process.env` mutation を使うものとそうでないものが混在しており、
  特定の env を期待する mock とそうでない test 間で副作用が起きうる
- `bun test` (default mode) は env mutation 副作用が「たまたま」観測されない順序で
  pass する可能性が高い (現状はそう動いている)

## 関連

- DR-0008 §5.1 / §6 — mock 撤去対象テストの仕様
- PR① journal — mock 排除方針の最初の確立
- メモリ: `feedback_csa_jsonl_all_fields_optional`
