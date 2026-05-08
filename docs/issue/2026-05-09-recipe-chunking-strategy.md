# レシピごとのチャンク分割戦略の見直し

## 問題提起

大きめセッションの結果を観察すると、レシピによって分割（`splitTimeline`）の効果が大きく異なる。

### レシピ別の傾向

- **diary**: 分割◎
  - 各チャンクで深く書いて並べると読み応えが出る
  - 一括処理だと平坦でだらだら長い文章になりがちだった
  - （※ Claude 本体や model の改善で今は変わっている可能性はあるが未検証）
- **todo**: 分割×（むしろ逆効果）
  - セクションごとに todo を作ると複数セッション全体で家具が膨大に増える
  - 前セッションで todo として挙げた項目が、次以降のセッションで既に解決していることが多い
  - 振り返ったときに「結局このセッションで何が TODO として残っているか」が読み取れない
- **summary, knowledge** (推定): 集約型なので分割は逆効果と思われる
  - summary は 300字目安なのに合成段階で膨らむ可能性
  - knowledge は全体俯瞰して抽出するのが本来の性質

### 構造的な背景

1. `chunker.ts` の `DEFAULT_MAX_CHUNK_BYTES = 35000` はモデルのコンテキスト 200k 時代の値
2. 現在は Opus 1M を使えるので、当時は無理だったサイズも単一パスで処理できる
3. しかし現状は全レシピ一律で 35KB を超えると分割パスへ強制的に乗る
4. レシピの「出力の性格」によって最適な分割戦略は本質的に異なる
   - 物語型（diary）: 各チャンクを深く書いて並べる（concat 合成）
   - 集約型（todo, summary, knowledge）: 全体を俯瞰して抽出する（分割しない or merge 合成）
   - 時系列型（changelog, blame）: 中間

## アシスタントの意見

### 賛成方向

レシピごとに「出力の性格」が違う以上、分割戦略もレシピ固有であるべき。frontmatter に分割制御パラメータを置くのは設計上正しい方向。

### ただし優先順位として先に考えるべきこと

#### 1. デフォルト値の見直しが先

`DEFAULT_MAX_CHUNK_BYTES = 35000` を Opus 1M 時代の現実的な値（例: 200000）に引き上げるだけで、多くのレシピで「分割が逆効果」問題が自動的に消える可能性がある。

レシピ単位パラメータを足す前に、まずグローバルデフォルトの妥当性を検証すべき。

#### 2. パラメータ化の前にミニマル設計を検討

`design-thinking.md` のワークアラウンドフィールド禁止ルールに従うと、フィールドを足す前に検討すべきこと:

- 既存の `on_existing` の意味を拡張すれば足りないか
- 単に `chunk: false` の bool 一個で済まないか
- 本当に `max_chunks` `synthesis` まで必要か（YAGNI）

最小案:

```yaml
chunk: false # bool（default: true）
```

拡張案（必要だと判断された場合）:

```yaml
chunk:
  enabled: false
  max_bytes: 200000
  max_chunks: 4
  synthesis: concat | merge # 物語型は concat、集約型は merge
```

#### 3. todo の「前回解決済みが残る」問題は分割と別レイヤー

これは分割粒度の話ではなく、todo レシピの本質的な設計問題:

- 前回出力を見ずにそのセッションだけから抽出している
- `on_existing: append` を使っても累積していくだけで剪定されない
- 本来は「前回の todo + 今回の差分 → 現在の todo」というマージ型処理が必要

この課題は frontmatter のチャンクパラメータでは解決しないので、todo レシピ単独で別途設計を見直す必要がある。

## 検討の入口候補

着手するならどれから始めるか（独立して進められる）:

1. **デフォルト値の見直し** - 現在の 35KB が適切か検証、必要なら引き上げ
2. **chunk bool の追加** - frontmatter で `chunk: false` を受け付ける最小実装
3. **todo レシピの再設計** - 前回出力を入力に取り込むマージ型処理

優先順位は (1) → (2) → (3) が自然。(1) で多くのケースが片付くなら (2) は不要かもしれない。

## 関連

- `src/lib/chunker.ts:56` `DEFAULT_MAX_CHUNK_BYTES`
- `src/lib/chunker.ts:57` `DEFAULT_MIN_CHUNK_BYTES`
- `src/lib/chunker.ts:58` `DEFAULT_MAX_CHUNKS`
- `src/commands/session-process.ts:501` `splitTimeline(timelineText)` の呼び出し
- `src/types/index.ts:5-12` `Recipe.match` の現在のフィールド定義
- `src/lib/recipe.ts:9-35` `parseRecipe` のフロントマター解釈
