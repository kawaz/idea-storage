# DR-0008: レシピパイプラインの品質改善（ノイズ判定 + dispatcher + 品質ガード）

## 背景

DR-0004 (queue persistence) と DR-0007 (queue state model 拡張) で「セッション × レシピ」のジョブ実行基盤は整ったが、**生成される出力の品質**には別軸の問題が積み残っていた。

### 観察された問題

`~/.local/share/idea-storage/` 配下の生成済み出力（特に diary 系）を多数読み返した結果、以下の癖が頻発していた:

- **テンプレ化**: 「寂しい」「気持ちよかった」「刺さった」「堪えた」等のフレーズが定型句として繰り返し使われる
- **空セッションでの無理な作文**: 1〜2 ターンで実質中身の無いセッションに対しても全レシピが発火し、「kawazさんへの過剰な愛着表現」「白紙のキャンバス」等の詩的逃避に偏る
- **まとめ癖**: 「弧を描いている」「〜こそが核心」等のエッセイ風総括の濫用
- **ノイズの timeline 混入**: `<system-reminder>` 等の hook 注入や `<task-notification>` がレシピのプロンプトに timeline 経由でそのまま渡されており、レシピが「中身のないターン」混じりで書かされている

### 測定（2026-04-21 実施）

直近 90 日のセッションから 159 件をサンプリングしてユーザーターンを分類:

| 分類                                                 | ターン数 |  割合 |
| ---------------------------------------------------- | -------: | ----: |
| EFFECTIVE（日本語含む or 3 word 以上の意味ある入力） |    1,337 | 80.0% |
| HIDDEN_TAG（hook 注入 / tool result / 特殊タグのみ） |      288 | 17.2% |
| SHORT_ASCII（ASCII 2 word 以下）                     |       43 |  2.6% |
| SLASH_ONLY（スラッシュコマンドのみ）                 |        4 |  0.2% |

セッション単位で「全ターンが non-EFFECTIVE」のものは **20 件 / 159 件 = 12.6%**。これらは現状フィルタ (`userTurns >= 1`) を通過しているが、レシピ実行は実質無価値。

### 現状フィルタ（`recipe-matcher.ts`）の限界

判定材料は `project` (glob) / `userTurns >= minTurns` / `ageSec >= minAge` の 3 つの数値メタのみ。会話の中身を一切見ていないため、上記の癖はどれも捕捉できない。レシピの frontmatter に判定キーを増やしても、こうした「内容の質」を表現するのは困難で、保守の重荷になる。

## スコープ

DR-0008 では以下の三段階パイプラインを導入する:

- **Phase 1: ノイズ判定基盤** — ユーザーターンを分類し、enqueue 時の「実質ターン」フィルタと process 時の timeline 整形に共通利用
- **Phase 2: dispatcher（二段キュー）** — 各セッションごとに LLM が「明らかに不適合な recipe」を除外し、採用 recipe だけを後段 enqueue
- **Phase 3: 品質ガード + 過去出力注入** — recipe 実行直後に出力の質を判定、不採用なら永続化スキップ。frontmatter で過去出力 N 本を recipe prompt に自動注入

**スコープ外**:

- **Phase 4: quality_guidelines.md の自動更新ジョブ** — 過去出力を週次/月次で分析して品質ガードのガイドを更新する仕組みは別 DR (DR-0009 予定) で扱う。Phase 1〜3 の運用結果を見てから設計する方が現実的なため
- **CSA (claude-session-analysis) 側の改修** — 仕様の正典は CSA に置くが、実装は別リポジトリ。idea-storage の `docs/issue/` で起票して非同期に進める

## 主要な設計判断

### 1. 三段階パイプライン構成（個別ではなく統合戦略）

| 案                                                | 利点                             | 欠点                                               | 判断 |
| ------------------------------------------------- | -------------------------------- | -------------------------------------------------- | ---- |
| A. 静的フィルタ強化のみ（frontmatter にキー追加） | 実装が軽い                       | 「内容の質」は表現できない、frontmatter ごちゃつき | ✗    |
| B. LLM dispatcher のみ                            | 中身を見て判定                   | 完全ノイズも LLM に投げる無駄、過剰品質判定        | ✗    |
| C. 品質ガードのみ（事後判定）                     | 出力の質を直接ガード             | 全レシピを毎回走らせるコスト                       | ✗    |
| D. 三段階統合（採用）                             | 各段階の役割を分業、コスト最適化 | 設計が複雑                                         | ✓    |

各段階の役割分担:

- **静的フィルタ（Phase 1）**: 「明らかに無のセッション」を LLM 呼び出し前に切る（コスト最少）
- **dispatcher（Phase 2）**: 「明らかに不適合な recipe」を除外（recipe 数の縦方向削減）
- **品質ガード（Phase 3）**: 「書いてみたが薄かった」を捕まえる（最終ガード）

測定値（159 セッション中）:

- Phase 1 のみ: 20 件除外（12.6%）
- Phase 2 を加える: 1セッションあたり平均 2-4 recipe 採用 → 出力数 9倍 → 2-4倍
- Phase 3 を加える: 「採用したが質低い」分を rejected/ に退避

### 2. 分類ロジックの正典は CSA、idea-storage は CSA jsonl 経由で取得

| 案                                    | 利点                                       | 欠点                                                     | 判断 |
| ------------------------------------- | ------------------------------------------ | -------------------------------------------------------- | ---- |
| α. CSA 一元化（採用）                 | 単一ソース、CSA 単独でもノイズ可視化の価値 | CSA バージョン依存                                       | ✓    |
| β. idea-storage 内で完結              | CSA に手を入れない                         | 仕様の二重実装、CSA の `isUserTurn()` と部分的な責務重複 | ✗    |
| γ. 両方に実装（共通テストで整合保証） | パフォーマンス調整の自由度                 | 二重メンテ、長期的に乖離リスク                           | ✗    |

CSA は既に `isUserTurn()` で `isMeta` / `isCompactSummary` / `[Request interrupted` / `<task-notification>` / `<teammate-message` を U イベントから除外している。今回追加する分類はこの既存責務の自然な延長。

idea-storage 側は `getSessionMeta()` と `session-jsonl.ts` の JSONL 直読を CSA `sessions --format jsonl <id>` 呼び出しに全面置換する。enqueue ループは「mtime と queue 状態で先絞り → 残ったセッションだけ per-session で CSA 呼び出し」とするため、CSA bin 起動コストは管理可能。

不採用: idea-storage 内で完結（β）すると、CSA の `isUserTurn()` の判定ルールと idea-storage 側の分類ルールが乖離するリスクが大きい。後述するターン分類は `isUserTurn()` を通過したターンに対する追加分類なので、責務的に CSA に置くのが自然。

### 3. ユーザーターンの分類カテゴリ

CSA の `isUserTurn()` を通過したユーザーターン（kind="U"）について、本文を以下に分類:

| カテゴリ    | 判定                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HIDDEN_TAG  | 内容が `<system-reminder>` / `<user-prompt-submit-hook>` / `<local-command-stdout>` 等のシステム注入タグのみで本文がほぼ無い |
| SLASH_ONLY  | スラッシュコマンドのみ（CSA は既に `<command-name>` から `cmd args` を抽出して desc 化済み）                                 |
| SHORT_ASCII | 全文が ASCII で空白区切りで 2 word 以下                                                                                      |
| EFFECTIVE   | 上記いずれにも該当しない（日本語含む or 3 word 以上）                                                                        |

判定優先度: HIDDEN_TAG > SLASH_ONLY > SHORT_ASCII > EFFECTIVE。

**SHORT_ASCII の役割**: 「最初の意味あるターンが存在するか」の判定材料。途中で混じる "1", "2", "ok" 等の選択肢回答を全て除外するわけではない（普通の会話の一部）。セッション内に EFFECTIVE が 1 つでもあれば「意味のある対話」として扱う。

不採用: 「effective_user_turns >= K」のような閾値設定は frontmatter に追加しない。`hasEffectiveTurn: bool` の意味で判定し、閾値に意味は持たせない（数値表現すると frontmatter のキーが増殖する誘惑が出る）。

### 4. CSA jsonl の出力フィールド拡張（idea-storage の依頼事項）

CSA `sessions --format jsonl` の現状フィールド: `sessionId, file, cwd, startTime, endTime, duration_ms, bytes, lines, turns, context`。

idea-storage の `getSessionMeta()` を CSA 経由に切り替えるため、以下を追加してもらう:

| フィールド           | 型             | 意味                                     |
| -------------------- | -------------- | ---------------------------------------- |
| `effectiveUserTurns` | number         | EFFECTIVE 分類に該当するユーザーターン数 |
| `forkedFrom`         | string \| null | フォーク元 session ID                    |
| `forkFirstNewUuid`   | string \| null | フォーク後の最初の新規 entry UUID        |

不要: `hasEnd`（summary イベントの有無）。idea-storage 側で実用利用は `session-list.ts` の "ended/active" 表示の 1 箇所のみで、`ageSec >= minAgeSec` で代替可能。

### 5. 静的フィルタ: enqueue 時の `no_effective_turn` skip

enqueue 時に CSA jsonl から `effectiveUserTurns` を取得し、0 ならそのセッション × 全 recipe について `queue_entries.status='skipped'`、`reason='no_effective_turn'`、`line_count=<現在のセッション行数>` で記録する。

| 案                              | 利点                             | 欠点                             | 判断 |
| ------------------------------- | -------------------------------- | -------------------------------- | ---- |
| 新規エントリを作らずスキップ    | DB 軽量                          | 「なぜ skip されたか」が追えない | ✗    |
| skipped で entry を作る（採用） | history 設計と整合、運用調査可能 | DB 行数増                        | ✓    |

DR-0007 の方針（「再処理候補を絞る」「成功率を集計する」のクエリが status 単独 WHERE で書けるよう skipped を一級市民化）と整合する。

### 5.1 enqueue 時の status 遷移ルール（重要）

DR-0007 では `queue_entries (session_pk, recipe_pk)` が UNIQUE で、enqueue は `INSERT OR IGNORE` を使う。本 DR で skipped を多用すると「一度 skipped 行ができると同一キーの再 enqueue が黙って無視され、追記で復帰すべきセッションが永久に止まる」問題が発生する。これを避けるため、enqueue ロジックを以下の通り変更する:

| 現在 status                             | line_count 比較 | 遷移先                                       | 備考                                                                                                                               |
| --------------------------------------- | --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 行なし                                  | —               | 新規 `queued`                                | 既存挙動                                                                                                                           |
| `done`                                  | new > old       | `queued` に再遷移                            | 既存挙動（差分処理）                                                                                                               |
| `done`                                  | new == old      | 触らない                                     | 既存挙動                                                                                                                           |
| `failed`                                | —               | 既存の retry 機構                            | DR-0004 / DR-0007 既存                                                                                                             |
| `skipped`, reason=`no_effective_turn`   | new > old       | `queued` に再遷移                            | 追記で effective ターンが追加された可能性                                                                                          |
| `skipped`, reason=`no_effective_turn`   | new == old      | 触らない                                     | セッション変化なし、再評価しても同じ                                                                                               |
| `skipped`, reason=`dispatcher_rejected` | new > old       | `queued` (recipe_name='dispatcher') に再遷移 | 追記で性質が変わった可能性、再 dispatch を発火させる                                                                               |
| `skipped`, reason=`dispatcher_rejected` | new == old      | 触らない                                     | 同上                                                                                                                               |
| `skipped`, reason=`quality_rejected`    | —               | 触らない                                     | 同セッション再実行で判断が覆る可能性は低い。quality_guidelines.md 更新時に `idea-storage session convert` で明示的に再実行する想定 |

これに伴い、enqueue 実装は `INSERT OR IGNORE` から「既存行を見て status と line_count で分岐する UPSERT」へ変更する。skipped 行も line_count を持つよう書き込み時に必須化する。

不採用案:

- **skipped を使わず entry を作らない**: `no_effective_turn` の累積件数を `queue_entries` で集計できなくなる（history は append-only で、現在の状態スナップショットには向かない）。DR-0007 の「skipped を一級市民として表現する」設計と矛盾
- **skipped を一括で再評価可能にする（reason 区別なし）**: `quality_rejected` まで毎回再評価すると LLM コストが膨らむ
- **再評価は明示コマンド限定（自動再 enqueue を一切させない）**: 追記の多いプロジェクトでは「最初の数ターンで dispatcher が rejected → その後 100 ターン続いた」がそのまま埋もれる。自動復帰は必要

### 6. dispatcher（Phase 2）: 二段キューを既存テーブルで表現

**新規テーブル不要**。DR-0007 で導入された `queue_entries` の `processing/skipped` status と `history` テーブルで全表現できる。

#### キューフロー

```
[enqueue]
  §5.1 の遷移ルールに従って既存行を見て分岐:
    effectiveUserTurns >= 1:
      (session, "dispatcher") を queued (or skipped→queued 復帰)
    effectiveUserTurns == 0:
      全 recipe について (session, recipe) を skipped(reason='no_effective_turn', line_count=N)
  すべての write は line_count を伴う

[process: recipe='dispatcher' のとき]
  claim → LLM 実行 → JSON 出力 parse
  → 採用 recipe について (session, recipe) を queued で追加（既存 done と line_count 比較）
  → 不採用 recipe について (session, recipe) を skipped(reason='dispatcher_rejected', line_count=N) で追加
  → history に action='dispatch_decided', message=JSON で記録
  → dispatcher 自身は markDone

[process: 通常 recipe のとき]
  既存フロー（DR-0007 の claim → 処理 → markDone）
```

dispatcher が採用 recipe を enqueue する際も §5.1 の遷移ルールを通す（既存 skipped/done 行の上書き判定）。

#### dispatcher 入力スキーマ

メタのみの最小スキーマ。タイムライン本文は渡さない。

```yaml
session:
  id: <uuid>
  project: <cwd>
  age_minutes: N
  user_turns: N
  effective_user_turns: N
  turn_classification:
    effective: N
    short_ascii: N
    slash_only: N
    hidden_tag: N
  duration_ms: N
  size_bytes: N
  forked_from: <id or null>

recipes_available:
  - name: diary
    hint: "<recipe.hint 1行>"
  - name: knowledge
    hint: "..."
```

不採用: 「最初の effective ターン本文を含める」案。最初と最後で関係ないことをやってるセッションが多く、一部を見ての判定は早計。dispatcher の役割は「明らかに不適合を除く」のみで、迷ったら採用する。微妙な判定は後段の品質ガードに委ねる。

#### dispatcher 出力フォーマット

JSON 採用リスト型:

```json
{
  "recipes": [
    { "name": "diary", "reason": "対話メイン、葛藤あり" },
    { "name": "knowledge", "reason": "新規API調査の記録あり" }
  ]
}
```

「書かない自由」は `"recipes": []` で表現。

不採用: YAML（LLM の引用符・改行ミスでパースが脆い）/ 自然言語 + 抽出（パース堅牢性が低い）。

#### parse 失敗 / 異常系の扱い

| ケース                                | ハンドリング                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| API timeout / 接続エラー / rate limit | dispatcher 自身を markFailed → 既存 retry 機構（DR-0007 のレールに乗る、24h × 3）                                            |
| プロセス起動失敗                      | 同上                                                                                                                         |
| JSON parse 失敗 / `recipes` キー無し  | **fallback**: 全 recipe を queued で enqueue + dispatcher は markDone（reason に `dispatcher_fallback:json_parse_error` 等） |
| `recipes` 配列に存在しない recipe 名  | 該当だけ警告ログ + 無視                                                                                                      |
| `"recipes": []`                       | 「書かない判断」として尊重、全 recipe を skipped(reason='dispatcher_rejected')                                               |

判断基準: transient（時間で解決する）は retry、structural（同じ入力で再実行しても同じ失敗）は fallback。LLM 出力の構造的崩れは structural 側に分類。

#### 再 dispatch の扱い

セッションが追記されて line_count が増えた場合の dispatcher 再実行は **完全上書き**: 同じ session に対して dispatcher を再 enqueue できる場合、最新の判断で前回の決定を上書きする。history には全イベントが残るため、過去の判断は履歴で追える。

### 7. recipe の `hint:` frontmatter キー

| 案                                      | 利点                       | 欠点                                                | 判断 |
| --------------------------------------- | -------------------------- | --------------------------------------------------- | ---- |
| frontmatter に `hint:` キー追加（採用） | 既存スキーマと整合、宣言的 | 1 キー追加                                          | ✓    |
| 本文の `## Hint` セクション             | frontmatter は触らない     | dispatcher 実装に Hint セクション抽出ロジックが必要 | ✗    |
| 別ファイル `recipe-*.hint.md`           | 完全分離                   | 管理対象が倍増                                      | ✗    |

`exclude` に絞らず、向き不向き両方を 1 行の自由テキストで表現する。明確に「向き」と「不向き」をキーで分けると保守の重荷になる。

例:

```markdown
---
match:
  project: "*"
hint: "技術検証・新規API調査・実験記録のセッションに向く。雑談や定型作業には不向き。"
---
```

`hint:` は **任意**。記載なし = dispatcher にとって判断不能 → 採用候補に含める（recall 重視のスタンスと整合、移行時に既存 recipe を全部書き換える必要なし）。

### 8. 品質ガード（Phase 3）

#### 実装位置

process の最後で一体化（recipe 実行 → 出力生成 → 品質判定 → 永続化 or `_rejected/` 退避）。

不採用: 別ジョブで非同期判定（テンポラリ状態管理が増える） / recipe prompt 内に組み込む（recipe ごとに判定基準が分散）。

#### 入力

出力本文のみ。元 timeline は渡さない。

不採用: 「出力本文 + timeline」（コスト倍）。品質ガードの目的は「読む価値のある出力か」を判定することで、出力単体で判定可能。「セッションが空っぽで出力も空っぽ」は Phase 1 + Phase 2 で除外済みのはずで、品質ガードは「中身ある input から薄い output が出てきた」を捕まえる役割。

#### 採否表現

二値（採用 / 不採用）+ reason テキスト。

不採用: スコア (1-10)（LLM の校正が不安定、閾値設定が校正に依存）。

#### 不採用判定時の出力扱い

`~/.local/share/idea-storage/_rejected/{recipe}/YYYY/MM/DD/...md` に退避。queue_entries は `status='skipped', reason='quality_rejected', line_count=N` で記録。

§5.1 の遷移ルールにより、`quality_rejected` は line_count に関わらず再 enqueue で自動復帰しない（同セッションを再実行しても同じ判断になる可能性が高いため）。`quality_guidelines.md` の更新によって判断が変わる見込みがある場合は、`idea-storage session convert --session <id> --recipe <name>` で明示的に再実行する想定。

理由: 不採用判定の精度を後から検証する素材になる、削除はいつでもできるが情報を残す方がコスト低い。

#### 対象 recipe

全 recipe 共通でデフォルト on。recipe 側で何も指定しない。「特定 recipe で off にしたい」要件が出たら opt-out キー（`quality_check_skip: true` 等）を後付けで足す。YAGNI。

#### 判定 prompt の方針

抽象基準（「読む価値があるか」「内容が薄くないか」）+ 具体ガイド（kawazさんが観察済みのテンプレ表現連発・過剰総括・過剰持ち上げ等の癖を判定指針として書く）。

prompt 本体は `~/.local/state/idea-storage/quality_guidelines.md` に外部化し、起動時に読み込む。初期版は git 管理の `config-examples/quality_guidelines.md` で配布。これにより、Phase 4 で自動更新ジョブを後付けする際の拡張点になる。

### 9. 過去出力注入

#### 指定方法

frontmatter に `inject_recent: N` キーを追加（任意）。実装側で recipe prompt の前または後ろに「直近 N 本の出力」を自動付加。

例:

```markdown
---
match:
  project: "*"
hint: "..."
inject_recent: 5
---

（recipe 本文。実装側で「直近 5 本の出力」を本文の前に自動付加してから claude に渡す）
```

`inject_recent: 0` または記載なし = 注入なし（recipe ごとの on/off も自動表現）。

#### 取得元

filesystem 直接走査: `~/.local/share/idea-storage/{recipe}/YYYY/MM/DD/*.md` をファイル名 timestamp でソートして直近 N 本。

不採用: queue.db に index テーブルを追加（DB と filesystem の同期問題が出る、既に filesystem ベースなので DRY 違反）。

#### 注入する単位

本数固定（`inject_recent: 5`）。トークン量や期間ベースは校正が複雑になるため不採用。

### 10. 出力 frontmatter に claude_model + claude_version

セッション処理プロセス起動時に 1 回 `claude --version` を取得してメモリにキャッシュ、各 process 呼び出しの frontmatter 生成時に参照する。

```yaml
session_id: ...
recipe: ...
generated_at: ...
claude_model: ...
claude_version: ...
```

理由: モデルバージョンアップで出力傾向が変化することが想定されるため、品質分析（Phase 4 含む）で「いつのモデルでの出力か」を追跡できるようにしておく。永続キャッシュは不要（launchd で 1 時間に 1 回起動なら、~100ms の取得コストは誤差）。

### 11. status / reason / history action の追加分類

DR-0007 で確立した命名慣習に沿って追加:

#### `queue_entries.reason` 接頭辞（既存に追加）

- `no_effective_turn` — Phase 1 で全ターンが non-EFFECTIVE のため skipped
- `dispatcher_rejected` — Phase 2 dispatcher が採用しなかった recipe
- `dispatcher_fallback:<理由>` — dispatcher の構造的失敗で全 recipe enqueue に倒した（dispatcher 自身の reason）
- `quality_rejected` — Phase 3 品質ガードが拒否した出力

#### `history.action` の追加

- `dispatch_decided` — dispatcher が判断を下したイベント。`message` に出力 JSON（採用 recipes、fallback フラグ、reason）

## 詳細設計

### CSA への依存

CSA への改修依頼は idea-storage の `docs/issue/` に起票して非同期に進める。idea-storage 側は CSA リリース後に `getSessionMeta()` 切り替えを ship する。

CSA 側の実装が出るまで、idea-storage は `session-jsonl.ts` 旧実装で動作（DR-0008 着手は CSA 改修と並行可能）。

### Phase 1 のサブ PR 分割

| PR  | 内容                                                                                                                                                                     | 目的                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| ①   | `getSessionMeta()` を CSA jsonl 由来に移行（旧 JSONL 直読を削除）                                                                                                        | 互換性維持で動作確認                            |
| ②   | enqueue ロジックを §5.1 の遷移ルールに従う UPSERT に変更（skipped 行も含む差分判定）。同時に `effectiveUserTurns < 1` で `skipped(no_effective_turn, line_count=N)` 記録 | フィルタ効果の単独計測 + skipped 復帰の動作確認 |

各 PR で動作観察ができる粒度で分割。

PR ② は `INSERT OR IGNORE` → UPSERT への変更を含むため、enqueue の単体テストを最初に書いてから実装する（TDD）。テスト観点: §5.1 の遷移表の各セルの挙動を網羅。

### Phase 2 / Phase 3 の単位

- Phase 2: dispatcher 関連を 1 PR にまとめる（recipe 解析・dispatcher 実行・enqueue 二段化・status='skipped' (dispatcher_rejected) の記録）
- Phase 3: 品質ガード + 過去出力注入を 1 PR で（quality_guidelines.md 外部化含む）

### マイグレーション

- DR-0007 の `applyMigrations()` で確立した PRAGMA user_version 方式に乗る。Phase 1〜3 は schema 追加なし（既存 status='skipped' / history を活用するため）
- 既存出力 frontmatter は触らない（claude_model/claude_version は新規分のみ）。filesystem 上の既存出力は LLM コスト消費済みのため、後付けで遡及記録するメリットなし
- 既存 queued エントリ: Phase 2 ship 時点で残っている `(session, 通常 recipe)` の queued エントリは旧フローでそのまま処理される（dispatcher 経由ではなく直接 process）。新規 enqueue 分から二段化が始まる。混在期間は問題なく自然消化される

### ロールバック

特別な仕組みは設けない。idea-storage の出力は元の JSONL から再生成可能（味付けに過ぎない）。Phase が進んで「やっぱり旧フローに戻したい」場合は旧版に戻して再 enqueue すれば類似出力が再生成される。

### 観測指標

`idea-storage session status` コマンドに以下を追加:

```
Skipped breakdown (last 30 days):
  no_effective_turn:    XXX
  dispatcher_rejected:  XXX
  quality_rejected:     XXX

Dispatcher fallback rate (last 30 days): X.X%
Quality gate rejection rate (last 30 days): X.X%
Effective filter pass rate (last 30 days): X.X%
```

データソースは `queue_entries.reason` の集計と `history.action='dispatch_decided'` の message パース。専用ダッシュボードは YAGNI、必要になったら status 出力を JSON 化して外部ツールに渡す形で拡張可能。

## 段階的 ship 計画

| Phase                  | ship タイミング                | 観察項目                                                   |
| ---------------------- | ------------------------------ | ---------------------------------------------------------- |
| Phase 1 (2 サブ PR)    | 各 PR ごとに ship & 観察       | skipped(no_effective_turn) 件数、出力数の変化              |
| Phase 2                | Phase 1 安定後                 | dispatcher fallback 率、各 recipe の採否分布、出力数の変化 |
| Phase 3                | Phase 2 安定後                 | quality_rejected 率、`_rejected/` 内容のスポットチェック   |
| Phase 4 (DR-0009 予定) | Phase 3 運用結果を見てから設計 | quality_guidelines.md の自動更新ループ                     |

## 実装完了状況 (2026-05-30)

DR-0008 の §1〜§11 すべて main にマージ済み。Phase 4 (DR-0009 予定) は本 DR の
スコープ外で、運用結果を見てから別 DR として起案する。

| §               | 内容                                                        | 対応 PR / commit                                                      |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| §1〜§3 (三段階) | パイプライン全体                                            | PR① / PR② / PR③ / PR④ で段階的に実装                                  |
| §4              | CSA jsonl フィールド拡張 (消費側; CSA 本体は別リポで対応済) | PR① (`10e043a6`)                                                      |
| §5              | 静的フィルタ + `skipped(no_effective_turn)` 記録            | PR② (`a256eb91`)                                                      |
| §5.1            | enqueue UPSERT 遷移ルール                                   | PR② (`a256eb91`) + PR③ (`7404b6a4`) で `dispatcher_rejected` 復帰追加 |
| §6              | dispatcher (二段キュー)                                     | PR③ (`7404b6a4`)                                                      |
| §7              | recipe `hint:` frontmatter                                  | PR③ (`7404b6a4`)                                                      |
| §8              | 品質ガード + `_rejected/` 退避                              | PR④ (`d3b8c628`)                                                      |
| §9              | 過去出力注入 (`inject_recent: N`)                           | PR⑤ (`69a6131d`)                                                      |
| §10             | 出力 frontmatter に `claude_model` / `claude_version`       | PR⑤ (`69a6131d`)                                                      |
| §11             | `session status` skipped breakdown (lifetime totals)        | PR⑥ (`4cde212d`)                                                      |

各 PR の経緯・設計判断詳細は `docs/journal/2026-05-30-pr{1,2,3,4,5,6}-*.md` を参照。

### スコープ内で残した未完了部分 (運用安定後に別 PR で対応)

- §11 の「last 30 days」時間窓フィルタ (現状は lifetime totals) →
  `docs/issue/2026-06-02-skipped-breakdown-30day-window.md` に切り出し済
  (DR-0009 Phase 6, 2026-06-02)
- §11 の `dispatcher fallback rate` / `quality gate rejection rate` /
  `effective filter pass rate` (history.action='dispatch_decided' のパース集計が必要) →
  `docs/issue/2026-06-02-dispatcher-fallback-and-quality-gate-rates.md` に
  切り出し済 (DR-0009 Phase 6, 2026-06-02)
- ~~`session-enqueue.test.ts` で `mock.module("../lib/queue.ts")` を継続使用している点
  (PR① の「mock 排除」方針との不整合; mock 撤去は別 PR で対応予定)~~ →
  **resolved (DR-0009 Phase 3 step 3-e+f, 2026-06-02)**: claude-runner.ts の
  `mock.module` 撤去 + session-process.test.ts の DI 化により、リポ全体の
  `mock.module` 件数は 0。
- `session-process.test.ts` の dispatcher / quality gate / inject_recent
  end-to-end 統合テスト (現状は各単体のみ)

## 関連 DR

- DR-0004: queue persistence — SQLite キューの基盤
- DR-0005: rate-limits-aware scheduling — claude API リミットを意識した自律スキップ
- DR-0007: session convert and queue state model — `queue_entries.status` (queued/processing/done/failed/skipped) と `history` テーブル、`reason` 接頭辞慣習。本 DR の前提
- DR-0009 (予定): quality_guidelines.md の自動更新ジョブ
