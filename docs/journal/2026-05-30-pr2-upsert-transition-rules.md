# 2026-05-30: DR-0008 Phase 1 PR② 完成 — §5.1 UPSERT 遷移ルール + no_effective_turn skip

## 達成

DR-0008 Phase 1 PR② を完成。enqueue ロジックを `INSERT OR IGNORE` から §5.1 遷移ルールに従う UPSERT に切り替え、`effectiveUserTurns=0` のセッションを `markSkipped(no_effective_turn, lineCount=N)` で記録するパスを追加。

- `bun test`: 736 pass / 0 fail (PR① 時 721 → +15)
- `bunx tsc --noEmit`: clean
- 既存 INSERT OR IGNORE 挙動と互換 (queued/processing/failed/done same-lineCount は触らない)、`done lineCount 増` / `skipped(no_effective_turn) lineCount 増` で自動 queued 復帰

## 設計判断

### 1. 復帰対象 reason を宣言的に管理 (`REENQUEUABLE_SKIPPED_REASONS`)

```ts
const REENQUEUABLE_SKIPPED_REASONS: ReadonlySet<string> = new Set(["no_effective_turn"]);
```

`quality_rejected` は「再実行しても判断が変わらない」ので含めない (DR-0008 §5.1)。Phase 2 で `dispatcher_rejected` を追加する拡張点として宣言的に定義。

不採用: 「全 skipped reason を一律復帰対象にする」案。Phase 3 の quality ガード判定が `idea-storage session convert` 経由でしか覆らない仕様 (DR-0008 §5.1) を破壊する。

### 2. `markSkipped` に `lineCount` 必須化

DR-0008 §5.1 「すべての write は line_count を伴う」要件の実装。これがないと skipped 行に line_count=NULL が混入し、後続の `shouldReenqueue` が NULL を 0 として扱って意図しない復帰 (= 1 行でも追記があれば復帰) を引き起こす。

callers の更新:

- `session-convert.ts:184`: `result.lineCount` を渡す
- `session-process.ts:670`: `meta.lineCount` を渡す (already_processed 用)
- `session-process.ts:695`: `result.lineCount` を渡す (processSession の skipped 戻り)
- `session-enqueue.ts` (新規): `meta.lineCount` を渡す (no_effective_turn 用)

### 3. `session-enqueue.ts` の二段防御

事前 state フィルタ (`state.queued`, `state.done`, `isFailedByState`) は残しつつ、`queue.ts` 側にも §5.1 ルールを持たせる。

- **事前フィルタ層**: 「無駄な DB UPDATE を避ける」最適化 (高速、状態は前回ロード時点のスナップショット)
- **queue.ts ルール層**: 「正しい挙動を保証する」 invariant (slow path、ライト時に最新の status を観測してから判断)

両方持つことで、並列実行でラウンドトリップ間に状態が変わっても DB 側の §5.1 ルールで invariant が守られる。

### 4. effectiveUserTurns=0 はループ内で分岐

session-enqueue の構造:

```
for each session:
  if meta.ageSec < minAgeSec: continue
  const noEffective = meta.effectiveUserTurns < 1
  for each recipe:
    if !matchesRecipe(recipe, meta): continue
    if (pre-filter says skip): continue
    if noEffective:
      noEffectiveSkips.push(...)
    else:
      pending.push(...)
enqueueBatch(pending)
for each noEffectiveSkip: markSkipped(no_effective_turn, ...)
```

不採用案:

- **effectiveUserTurns 判定をループの外に出す**: matchesRecipe 後の事前フィルタも適用したいので難しい
- **markSkipped を batch 化** (`markSkippedBatch`): YAGNI。1 enqueue 実行で no-effective は数件程度の想定で、各単発 UPSERT のコストは無視できる

### 5. dispatcher は **PR② スコープ外**

DR-0008 §6 で「effectiveUserTurns >= 1 → (session, 'dispatcher') を queued」というルールが書かれているが、dispatcher 自体は Phase 2 PR で実装する。PR② では:

- `effectiveUserTurns >= 1` → 既存の matchesRecipe ループ → enqueueBatch (各 recipe を直接 queued、dispatcher を経由しない)
- Phase 2 PR で「matchesRecipe ループの代わりに dispatcher 経由」に切り替える

PR を細かく刻むことで、観察と運用結果のフィードバック区間を作る (Phase 1 のフィルタ効果単独計測)。

## ハマり所 → 解決策

### 1. `createSessionFile` のデフォルト "Hello" が SHORT_ASCII 判定

PR① 時の session-enqueue.test.ts の fixture は user content `"Hello"` (ASCII 1 word) を書いていた。CSA の SHORT_ASCII 判定 (ASCII 2 word 以下) に該当し、`effectiveUserTurns=0` になる。

PR① では `effectiveUserTurns` を見ていなかったので問題が出なかったが、PR② で `< 1` skip 分岐を追加した瞬間に既存テストが全 fail (`enqueueCalls.length === 0`)。

**解決**: デフォルト content を `"ユーザの実質的な発言 hello world"` に変更 (日本語含む → EFFECTIVE)。加えて `noEffectiveTurn?: boolean` opts を追加し、明示的に SHORT_ASCII を選べるようにして PR② の新規テストで使用。

### 2. `session-enqueue.test.ts` の `mock.module("../lib/queue.ts")` で `markSkipped` 未定義

PR② で session-enqueue.ts が `markSkipped` を新規 import。test 側は queue.ts を mock していたため `Export named 'markSkipped' not found` で全 fail。

**解決**: mock.module に markSkipped を追加し、`markSkippedCalls` 配列で記録できるようにした。

**残課題**: そもそも `session-enqueue.test.ts` で queue.ts を mock しているのは PR① の「mock 排除方針」に反する。実 queue.ts を tempDir DB で呼ぶスタイルに統一すべき。これは PR② スコープを膨らませないため別 PR で対応 (本 journal の「残課題」参照)。

## §5.1 遷移表テスト網羅

`queue.test.ts` の `describe("enqueueBatch transitions (DR-0008 §5.1)")` で 12 ケース網羅:

| ケース                                              | 結果                               |
| --------------------------------------------------- | ---------------------------------- |
| 行なし → 新規 queued                                | line_count 付き INSERT             |
| queued → no-op                                      | line_count 保持                    |
| processing → no-op                                  | status='processing' のまま         |
| done, new > old → queued 復帰                       | line_count 更新、reason=NULL       |
| done, new == old → no-op                            | done のまま                        |
| done, new < old → no-op (退行防止)                  | done のまま、line_count 保持       |
| failed → no-op                                      | retry 機構に委譲                   |
| skipped(no_effective_turn), new > old → queued 復帰 | line_count 更新                    |
| skipped(no_effective_turn), new == old → no-op      | skipped のまま                     |
| skipped(quality_rejected) → no-op                   | reason 保持                        |
| skipped(dispatcher_rejected) → no-op                | PR② スコープ外、Phase 2 で復帰追加 |
| skipped(unknown reason) → no-op                     | デフォルト保守                     |
| skipped → queued 復帰時の history                   | `reset` action 記録                |

## 変更ファイル

7 ファイル:

| ファイル                               | 内容                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/queue.ts`                     | `enqueue` / `enqueueBatch` を §5.1 UPSERT 化、`markSkipped` に `lineCount` 引数追加、`REENQUEUABLE_SKIPPED_REASONS` / `shouldReenqueue` / `upsertQueuedTransition` 追加 |
| `src/commands/session-enqueue.ts`      | `effectiveUserTurns < 1` で `markSkipped(no_effective_turn, lineCount)`、`enqueueBatch` に lineCount 受け渡し、log に `skipped_no_effective` カウント追加               |
| `src/commands/session-convert.ts`      | `markSkipped(..., result.lineCount)`                                                                                                                                    |
| `src/commands/session-process.ts`      | `markSkipped(..., meta.lineCount / result.lineCount)` x2                                                                                                                |
| `src/lib/queue.test.ts`                | §5.1 遷移表 12 ケース新規追加、既存 enqueue/markSkipped 呼び出しに lineCount 追加                                                                                       |
| `src/commands/session-enqueue.test.ts` | mock に markSkipped 追加、createSessionFile デフォルトを EFFECTIVE 化 + `noEffectiveTurn` opts、新規 2 ケース                                                           |

## 残課題

1. **`session-enqueue.test.ts` から queue.ts mock を撤去**: PR① の「mock は筋悪、契約は実機で検証する」方針との整合。tempDir DB を使う実 queue.ts 呼び出しに切り替えるべき (別 PR)
2. **dispatcher 関連 (`dispatcher_rejected` 復帰、recipe `hint` frontmatter、dispatcher prompt)**: DR-0008 Phase 2 PR で実装
3. **品質ガード (Phase 3)**: 出力 LLM 判定 + `_rejected/` 退避 + `inject_recent` (DR-0008 Phase 3)
4. **観測指標** (`idea-storage session status` に skipped breakdown 等): DR-0008 §11、運用が安定してから追加

## 関連

- DR-0008 §5.1: 遷移ルール表の正本
- DR-0008 PR① journal: `docs/journal/2026-05-30-pr1-csa-fixture-migration.md`
- メモリ: `feedback_csa_jsonl_all_fields_optional` / `feedback_autonomous_mode_user_remote`
