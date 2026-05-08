# Recipe Authoring Guide

`idea-storage` で自分用のレシピを書き足すためのガイドです。レシピの仕組み・配置場所・YAML
frontmatter の仕様・プロンプトの書き方・動作確認の手順までを一通りカバーします。

## What is a recipe?

idea-storage は Claude Code のセッション JSONL を「記事 (article)」へ変換するパイプラインで、
変換ルールを記述するのが **recipe** です。1 セッションを 1 つの recipe で処理すると、
その recipe 名のディレクトリ配下に Markdown 記事が 1 ファイル出力されます。複数 recipe を
登録しておけば、同じセッションから異なる切り口の記事を並行して生成できます (作業日誌・
未解決タスク・上司向け報告、など)。

## File structure

- ファイル名: `recipe-<name>.md` (例: `recipe-todo.md` → recipe 名 `todo`)
- 配置場所: `~/.config/idea-storage/recipe-*.md` (XDG: `$XDG_CONFIG_HOME/idea-storage/`)
- フォーマット: YAML frontmatter + プロンプト本文

> 注: recipe ファイルは `recipes/` サブディレクトリではなく、`config.ts` と同じ
> `~/.config/idea-storage/` の直下に置きます (`src/lib/paths.ts` の `getRecipesDir()` 参照)。

レシピ名は `recipe-` プレフィックスを除いた部分が使われ、出力ディレクトリ名・
コマンドラインの `--recipe` 引数・queue キーの後半 (`{sessionId}.{recipeName}`) に登場します。

## YAML frontmatter spec

実装は `src/lib/recipe.ts` (`parseRecipe`) と `src/lib/recipe-matcher.ts` (`matchesRecipe`)。
型定義は `src/types/index.ts` の `Recipe` インターフェース。

| Field             | Type                                   | Default    | Description                                                                                               |
| ----------------- | -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `match.project`   | string (glob)                          | (なし)     | プロジェクトパス (セッションの cwd) の glob フィルタ。 `*` は内部的に `**` に正規化される                 |
| `match.min_turns` | number                                 | `1`        | この値未満の `userTurns` を持つセッションは対象外。デフォルト 1 はユーザ発話 0 のセッションを除外する意味 |
| `match.min_age`   | number (秒)                            | (なし)     | この秒数未満しか経過していないセッションは対象外。「途中のセッションを早すぎるタイミングで処理しない」用  |
| `on_existing`     | `"skip"` \| `"append"` \| `"separate"` | `"append"` | 同じ `(session, recipe)` の出力が既にある場合の扱い (詳細下記)                                            |

> `on_existing` のデフォルトは **`append`** です (実装上 `"separate" | "skip"` 以外は append に
> フォールバック)。タスク先行ドキュメント等で「default skip」と書かれているのは誤り。最新の
> `src/lib/recipe.ts` を正とします。

### `match.project` の glob ルール

```typescript
// src/lib/recipe-matcher.ts (抜粋)
const pattern = match.project.replace(/(?<!\*)\*(?!\*)/g, "**");
const glob = new Bun.Glob(pattern);
if (!glob.match(session.project)) return false;
```

Bun.Glob の `*` はパス区切り (`/`) を跨がないので、recipe 側で書いた単体の `*` は
**自動で `**`にアップグレード**されます。これにより`_/myapp/_`のような直感的な
書き方でも`~/work/myapp/sub/dir` にマッチします。`\*\*` を明示しても OK。

### `on_existing` の挙動

| 値         | 挙動                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `append`   | 既存ファイルがあっても再生成。プロンプトに「Note: Session continued. Please append to existing entry.」が自動付加され、追記スタイルの出力を促す |
| `skip`     | 同じ `(session, recipe)` で既に出力があり、対象セッションの行数が増えていなければスキップ                                                       |
| `separate` | 別ファイルとして並べて生成 (タイムスタンプで一意になる)                                                                                         |

> `idea-storage session convert --session ... --recipe ...` は明示指示扱いなので
> `forceProcess=true` で実行され、`on_existing` の判定をスキップして強制再生成します。

## Examples

### Minimal recipe

最低限の構成。frontmatter で対象を絞り、本文がそのままプロンプトとして Claude に渡る:

```markdown
---
match:
  min_turns: 3
  min_age: 1800
on_existing: skip
---

未解決のタスク・積み残し・宿題を箇条書きで抽出してください。
各項目には「文脈 / 次にやるべきこと / blocker」を 1 行ずつ書いてください。
```

### Filter by project

特定のプロジェクト配下のセッションだけ対象にする:

```markdown
---
match:
  project: "*/myapp/*"
  min_turns: 5
---

このセッションで myapp に対して行った変更をリリースノート風にまとめてください。
```

### Re-run on session updates

セッションが伸びるたびに追記したい (作業日誌など):

```markdown
---
match:
  min_turns: 1
on_existing: append
---

今日の作業日誌として、時系列で起きたことと感想を書いてください。
```

## Prompt writing tips

1. **チャンク分割を意識する**
   - タイムラインが大きいと `splitTimeline` (`src/lib/chunker.ts`) によりターン境界 +
     時間ギャップ + 日付境界 + サイズ制約 (デフォルト 35000 バイト/チャンク, 最大 8 チャンク)
     で自動分割される
   - 各チャンクが独立で意味を成すプロンプト (「このチャンクで起きたことを箇条書きで」など)
     にすると、結合後も破綻しにくい
2. **会話タイムラインの形式**
   - `claude-session-analysis` (CSA) の `timeline --md --no-emoji` 形式で渡される
   - ブロック種別は `U`(user) / `T`(thinking) / `R`(assistant reply) / `B`(tool input) /
     `F`(tool result) / `G` / `W` / `S` 等。プロンプト中で参照したいときの目印に使える
3. **markdown を明示的に求める**
   - 出力は frontmatter + プロンプトに従った markdown が想定。表・コードブロック・
     見出しを欲しいときはプロンプトでハッキリ指示する
4. **frontmatter は自動付与される**
   - `session_id`, `project`, `session_start`, `session_end`, `generated_at`, `recipe`,
     `user_turns`, `session_bytes`, `duration_ms`, (フォーク時のみ) `forked_from` が
     自動で先頭に付くので、本文側で重複させる必要はない
5. **redaction が走る**
   - `src/lib/redact.ts` がタイムラインに対してシークレットらしき文字列をマスクしてから
     Claude に渡す。レシピ側で「シークレットを書き出して」のような指示は意味がないし望ましくない
6. **フォークセッション時は注釈が自動付加される**
   - 親セッションからフォークした場合、フォーク以降の差分のみがタイムラインとして渡され、
     プロンプト末尾に「このセッションは元セッション {parentId} からフォークされたもの」という
     注釈が自動で付く

## Reference: 既存 recipes

```bash
ls ~/.config/idea-storage/recipe-*.md
```

リポジトリのリファレンス例は `config-examples/` にまとめる方針 (recipe-\* を追加する
PR を歓迎)。各レシピは「目的」「想定される使用頻度」「`on_existing` の選択理由」を
冒頭コメントで添えておくと再利用しやすくなります。

## Testing your recipe

新規 recipe を `~/.config/idea-storage/recipe-<name>.md` に置いた後の動作確認手順:

1. enqueue できるか確認:
   ```bash
   idea-storage session enqueue
   idea-storage session list
   idea-storage session status
   ```
   `match.*` の条件にハマったセッションがキューに積まれていれば OK。
2. 1 件だけ手動で変換してプロンプトを検証:
   ```bash
   idea-storage session convert --session <sessionId> --recipe <name>
   ```
   `convert` は queue を経由せず明示指示で 1 ペアだけ動かすため、`on_existing` も
   スキップされます (`forceProcess=true`)。
3. 出力確認:
   ```bash
   ls ~/.local/share/idea-storage/<name>/YYYY/MM/DD/
   idea-storage article list
   idea-storage article view
   ```
   出力ファイル名は `{yyyymmddTHHMMSSZ}.{sessionId}.md` (セッション開始時刻 UTC ベース)。

## Trouble shooting

| 症状                                          | 確認ポイント                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| recipe にマッチしない                         | `match.min_turns` / `match.min_age` を満たしているか。`match.project` の glob が正しいか。`session list` でセッション側の cwd を確認 |
| `match.project` の glob が効きすぎる/効かない | `*` は自動で `**` 化される (パス区切りを越える)。意図的に 1 階層だけにしたい場合は `?` 系の指定で代替できないか検討                  |
| 出力が空 / `skipped` ログが出る               | `userTurns === 0` (空セッション)、または `on_existing: skip` で行数が増えていないケースが多い                                        |
| Claude API のレートリミットで止まる           | `docs/dr-005-rate-limits-aware-scheduling.md` 参照。worker は自動で skip して次の launchd 起動まで待つ                               |
| 大きいセッションで一部しか反映されない        | `splitTimeline` でチャンク分割されている可能性大。各チャンクで完結するプロンプトに書き換える                                         |
| frontmatter が解釈されない                    | `src/lib/frontmatter.ts` は最大 2 段ネストの簡易パーサ。リスト・複雑な YAML 機能は使えない。値はクォートしないと数値に解釈される     |

## Related docs

- `README.md` -- CLI 全体の使い方とインストール
- `docs/dr-002-chunked-processing.md` -- チャンク分割の設計判断
- `docs/dr-003-fork-session-handling.md` -- フォークセッションの扱い
- `docs/dr-004-queue-persistence.md` -- queue (SQLite) の構造
- `docs/dr-005-rate-limits-aware-scheduling.md` -- レートリミット監視
