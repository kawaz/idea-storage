# 2026-05-09: DR-0008 起こし — レシピパイプライン品質改善の grill-me 詰め

## 経緯

数日にわたるセッションで、生成済みの diary 等を多数読み返した結果として「テンプレ収斂」「空セッションでの無理な作文」「kawazさんへの過剰愛着表現」「弧を描いて締める癖」といった出力品質の問題が観察された。これらをコード側の改善で解決する案として、当初は次の 3 切り口で議論を始めた:

1. 静的フィルタ強化（frontmatter にキー追加で `effective_user_turns >= K` 等）
2. LLM dispatcher（recipe を絞り込む）
3. 過去出力注入（テンプレ回避）

途中で測定（90 日 / 159 セッションサンプリング）を挟み、想定とのズレが見えた:

- 「effective ターン 0 のセッション」は予想（30%+）より少なく、12.6%
- ただしターン単位では 17.2% が HIDDEN_TAG（hook 注入や tool result）
- 静的フィルタ単独では 1/10 削減目標は無理 → dispatcher が必須
- 想定外の発見: HIDDEN_TAG ノイズが timeline 経由でレシピプロンプトに混入していた = 「中身のないターン混じりで書かされていた」のがテンプレ収斂の一因の可能性

この発見から「Phase 1: ノイズ判定基盤」が新たに浮上し、「enqueue フィルタ」と「process 時の timeline 整形」の両方で同じ判定ロジックを共用する設計になった。

## grill-me で詰めた論点と決定

`/grill-me` を起動して決定木を辿り、各論点に推奨案を提示しながら順次詰めていった。

### 主要な転換点

- **Q1 で当初は「idea-storage 側で完結（独自 turn-classifier）」を推した** が、ユーザから「CSA も自分のプログラムなのでバックポート検討」の提案。CSA の `isUserTurn()` を確認したところ既にシステム由来エントリの除外をしており、追加分類はその自然な延長と判明。CSA 一元化に方針転換
- **enqueue 時の per-session CSA 呼び出しコストを当初懸念** したが、ユーザから「mtime / queue 状態で先絞りすれば数千件全部叩くわけじゃない、同じ PC 上ならどっちのプロセスでやっても損得無し」の指摘。ハイブリッド案を捨てて per-session 案に倒した
- **dispatch_decisions テーブル追加を当初提案** していたが、ユーザから「別セッションでキュー管理に変更があった」の指摘で確認したところ、DR-0007 で `history` テーブルと `status='skipped'` が既に導入済み。新規テーブル不要で `history.action='dispatch_decided'` と `queue_entries.status='skipped' (reason='dispatcher_rejected')` で全表現できることが判明。設計が大幅にシンプル化
- **dispatcher 入力に「最初の effective ターン本文」を入れる案を推した** が、ユーザから「最初と最後で全然関係ないことやってることが多い、一部を見ての判断は早計」の指摘。dispatcher の役割は「明らかに不適合の除外」のみに絞り、迷ったら採用 → 後段の品質ガードに委ねる設計に
- **品質ガード prompt の癖検出を「具体ガイド」として静的に書く案** に対し、ユーザから「具体ガイドによる補正やモデルバージョンアップで傾向が変化するので定期分析自動化したい」の追加要件。Phase 4 として別 DR (DR-0009 予定) に切り出し、DR-0008 では「prompt の外部ファイル化」だけ確定

### 決定一覧（要約）

DR-0008 本体に詳細を書いたのでここでは要約のみ:

- **Phase 1**: CSA に分類関数を追加 / `effectiveUserTurns` 等を jsonl 列追加 / `--effective-only` フラグ追加 / idea-storage は CSA jsonl 経由に全面置換
- **Phase 2**: dispatcher を二段キューで実装、既存 `queue_entries.status='skipped'` と `history` テーブルを活用、recipe.hint frontmatter 任意キー、JSON 出力、structural failure は fallback、transient failure は retry
- **Phase 3**: 品質ガードを process 末尾で一体化、出力本文のみを LLM 判定、`_rejected/` 退避、過去出力注入は frontmatter `inject_recent: N` キー
- **段階的 ship**: Phase 1 を 3 サブ PR に分割 → Phase 2 → Phase 3
- **追加要件**: 出力 frontmatter に `claude_model` / `claude_version` を記録（モデルバージョン追跡）

## 並行進行

- 当初 cmux-msg で CSA 用子セッション (1B43B895) を spawn して仕様議論を並行で進める形を試行した。一旦本セッションを終了 → resume したため子セッションは dead に。代替案として idea-storage の `docs/issue/` で起票して非同期化する方針に転換（kawaz の `docs-knowledge-flow.md` ルールに沿う）
- `docs/issue/2026-05-09-csa-noise-classification.md` を起票し、CSA 改修の依頼内容（分類関数 / jsonl フィールド / timeline フラグ）と判定境界の議論論点（word 区切り定義 / HIDDEN_TAG 境界 / SHORT_ASCII 閾値）を整理
- DR-0008 起票後、`plan-review-with-codex.md` ルールに従い codex レビューを背景実行

## codex レビュー指摘への対応（2026-05-09）

致命的指摘 1 件を受理して DR-0008 を修正:

> `skipped` を使う設計が、現行キュー実装では「将来の再評価不能」を引き起こす。`queue_entries (session_pk, recipe_pk)` UNIQUE + `INSERT OR IGNORE` のため、一度 skipped 行ができると同一キーの再 enqueue は黙って無視される。`no_effective_turn` で落としたセッションが追記後に復帰できない、`dispatcher_rejected` が後続追記で覆らない、Q6.1 の「再 dispatch は完全上書き」と矛盾。

対応:

- DR-0008 §5.1 として「enqueue 時の status 遷移ルール」を新設。reason 別に line_count 比較で再 enqueue 判定する仕様を明記
- `no_effective_turn` / `dispatcher_rejected` は line_count 増で `queued` に再遷移可能（追記で性質が変わった可能性に対応）
- `quality_rejected` は line_count に関わらず触らない（同セッション再実行で判断が覆る可能性は低い、`session convert` で明示再実行する想定）
- enqueue 実装は `INSERT OR IGNORE` から UPSERT に変更（PR ② で対応、TDD で遷移表を単体テストから書く）
- skipped 行も line_count 必須化、§6 dispatcher のキューフローと §8 品質ガードの記録方針も整合させて更新

この指摘は DR-0007 の「skipped を一級市民として表現する」設計の本来意図（永続スキップ）と、本 DR で導入したい「条件次第で復帰したいスキップ」のミスマッチに起因する。reason 別の遷移ルールで両立させる形に倒した。

## 観察された運用知見

- 設計が固まる前に実装に走らなかったことで、DR-0007（queue refactor）を発見してから設計を組み替える余地があった。grill-me モードで決定木を順に辿る形が今回の規模の DR には合っていた
- 当初の自分の推奨が「idea-storage 完結」「最小スキーマ + 最初のターン本文」「dispatch_decisions 新規テーブル」と、それぞれ「自分のスコープに閉じる」「情報を増やす」「専用構造を作る」方向に偏っていた。ユーザの指摘で「公共資産（CSA）に置く」「役割を絞る（除外のみ）」「既存資産を活用する（history テーブル）」に倒れたパターンが多かった
- 測定値（159 中 12.6%）から「セッション削減は限定的、ターン純化が主効果」が見えたのが大きい。数字を取らずに dispatcher 単独で目標達成できると思い込まなかったのは良かった

## 次のアクション

- codex レビュー結果を読んで致命的指摘があれば DR-0008 / CSA issue に反映
- DR-0008 / CSA issue / INDEX.md / 本 journal を関心事ごとに jj split → describe → push
- CSA 側の改修を待って Phase 1 のサブ PR ① 着手（CSA jsonl 由来の `getSessionMeta()` 移行）

## 関連ファイル

- `docs/decisions/DR-0008-recipe-pipeline-quality-improvement.md` — 本決定の正典
- `docs/decisions/INDEX.md` — DR-0008 を Active セクションに追加
- `docs/issue/2026-05-09-csa-noise-classification.md` — CSA への改修依頼
- `docs/decisions/DR-0007-session-convert-and-queue-state-model.md` — 本 DR が前提とする queue モデル
- `docs/decisions/DR-0004-queue-persistence.md` — SQLite キューの基盤
