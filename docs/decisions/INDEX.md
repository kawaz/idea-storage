# Decision Records

## Active

- [DR-0001](DR-0001-bugfix-and-view-command.md) — accepted (2026-02-22) — TypeScript/Bun リファクタ後のバグ修正と view サブコマンド (fzf + mdp TUI ビューア) の追加
- [DR-0002](DR-0002-chunked-processing.md) — accepted (2026-02-22) — 大規模セッションをタイムライン分割 + 並列 claude 呼び出し + 合成で処理する方式
- [DR-0003](DR-0003-fork-session-handling.md) — accepted (2026-02-22) — フォークセッションの `forkedFrom` 検出と UUID ベースのタイムライン切り詰め
- [DR-0004](DR-0004-queue-persistence.md) — accepted (2026-04-10) — ファイルベースキューを `bun:sqlite` 駆動の SQLite キューへ移行
- [DR-0005](DR-0005-rate-limits-aware-scheduling.md) — accepted (2026-04-13) — `ANTHROPIC_LOG=debug` ヘッダ抽出による rate_limits 観測と自律スキップ
- [DR-0006](DR-0006-ci-with-github-actions.md) — accepted (2026-05-08), **partially superseded by DR-0010** (2026-06-02) — GitHub Actions による CI 導入と旧 `build-check` ターゲットの撤廃 (build 強制部分は DR-0010 で撤回)
- [DR-0007](DR-0007-session-convert-and-queue-state-model.md) — accepted (2026-05-08) — `session convert` サブコマンド追加と queue state モデル拡張 (`processing` / `skipped` / FK 正規化 / history)
- [DR-0008](DR-0008-recipe-pipeline-quality-improvement.md) — accepted (2026-05-09), implemented (2026-05-30), refactored (2026-06-02) — レシピパイプラインの品質改善（ノイズ判定基盤 + LLM dispatcher 二段キュー + 品質ガード + 過去出力注入）。DR-0009 Phase 3 で mock 撤去残課題が解決済、§11 残指標は `docs/issue/2026-06-02-*.md` に切り出し
- [DR-0009](DR-0009-architecture-refactor-roadmap.md) — accepted (2026-06-01) — ゼロベースレビューに基づくアーキテクチャ・セキュリティリファクタリングロードマップ (8 Phase)
- [DR-0010](DR-0010-bundle-removal-and-zsh-plugin-installation.md) — accepted (2026-06-02) — bundle/dist 廃止 + claude-cmux-msg パターン採用 (bash wrapper + plugin.zsh)、DR-0006 の build 強制部分を supersede

## Superseded

(なし)

## Archived

(なし)
