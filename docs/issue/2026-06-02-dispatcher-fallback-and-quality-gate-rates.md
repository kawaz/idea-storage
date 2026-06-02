# dispatcher fallback rate / quality gate rejection rate / effective filter pass rate を `session status` に追加

DR-0008 §11 で観測対象として規定されたが未実装の指標 3 種。データソースは:

| 指標                        | データソース                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| dispatcher fallback rate    | `history.action='dispatch_decided'` の `message` (JSON) を parse、`fallback: true` の比率       |
| quality gate rejection rate | `queue_entries.reason='quality_rejected'` の件数 / Phase 3 まで到達した出力数 (= 採用 + 拒否)   |
| effective filter pass rate  | `(session, dispatcher) を enqueue した数) / (session を見た全件) ≈ (effectiveUserTurns>=1) の率 |

## 設計上の論点

- **history.message のスキーマ確定**: 現在 dispatch_decided の message は自由
  形式 JSON。コラム化 (= 専用テーブル分離) か継続パースかを判断する必要あり。
  DR-0009 Phase 6 §6 (= 別途 kawaz 判断必須) の dispatcher 入力スキーマ判断と
  関連する。
- **window**: skipped breakdown と揃えて 30 日窓 (関連 issue:
  `2026-06-02-skipped-breakdown-30day-window.md`)
- **表示形式**: 累計 / 30 日 / 直近 100 件 のどれをデフォルトにするか

## 受け入れ条件

- `session status` 出力に上記 3 値が `XX.X%` 形式で表示される
- 30 日窓で集計
- DR-0008 §11 のサンプル出力 (本文参照) と一致する形式

## 関連

- DR-0008 §11
- DR-0009 Phase 6 (DR 残課題のクリーンアップ)
- 関連 issue: skipped breakdown 30 日窓
