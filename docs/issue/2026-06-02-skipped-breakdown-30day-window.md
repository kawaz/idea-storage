# skipped breakdown に「直近 30 日」時間窓フィルタを追加

`session status` の `Skipped breakdown` セクションは現在 lifetime totals を返す
(DR-0008 §11 の本来の仕様は last 30 days 窓)。長期運用すると累計だけ膨らんで
最近の傾向が見えなくなるので、`queue_entries.updated_at` を使って 30 日窓に
絞る。

## 現状

- `getSkippedBreakdown()` 実装位置: `src/lib/queue/queue-state.ts`
- 集計対象: `queue_entries WHERE status='skipped'` の全件
- DR-0008 §11 の sample 出力には `(last 30 days)` と明記されている

## 期待される挙動

- 既定で `updated_at >= now - 30d` の行のみを reason 集計
- (任意) `--since <duration>` 等のオプションで窓を可変にできるとよいが
  まずは固定 30 日でよい (実装の単純化を優先)

## 関連

- DR-0008 §11
- DR-0009 Phase 6 (DR 残課題のクリーンアップ)
