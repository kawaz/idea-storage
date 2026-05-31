# Decision Records

## Active

- [DR-0001](DR-0001-bugfix-and-view-command.md) — accepted (2026-02-22) — TypeScript/Bun リファクタ後のバグ修正と view サブコマンド (fzf + mdp TUI ビューア) の追加
- [DR-0002](DR-0002-chunked-processing.md) — accepted (2026-02-22) — 大規模セッションをタイムライン分割 + 並列 claude 呼び出し + 合成で処理する方式
- [DR-0003](DR-0003-fork-session-handling.md) — accepted (2026-02-22) — フォークセッションの `forkedFrom` 検出と UUID ベースのタイムライン切り詰め
- [DR-0004](DR-0004-queue-persistence.md) — accepted (2026-04-10) — ファイルベースキューを `bun:sqlite` 駆動の SQLite キューへ移行
- [DR-0005](DR-0005-rate-limits-aware-scheduling.md) — accepted (2026-04-13) — `ANTHROPIC_LOG=debug` ヘッダ抽出による rate_limits 観測と自律スキップ
- [DR-0006](DR-0006-ci-with-github-actions.md) — accepted (2026-05-08) — GitHub Actions による CI 導入と旧 `build-check` ターゲットの撤廃
- [DR-0007](DR-0007-session-convert-and-queue-state-model.md) — accepted (2026-05-08) — `session convert` サブコマンド追加と queue state モデル拡張 (`processing` / `skipped` / FK 正規化 / history)
- [DR-0008](DR-0008-recipe-pipeline-quality-improvement.md) — accepted (2026-05-09), implemented (2026-05-30) — レシピパイプラインの品質改善（ノイズ判定基盤 + LLM dispatcher 二段キュー + 品質ガード + 過去出力注入）

## Superseded

(なし)

## Archived

(なし)
