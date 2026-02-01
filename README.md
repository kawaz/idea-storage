# idea-storage

Claude Code セッションログからレシピベースでドキュメントを自動生成する CLI ツール。

## インストール

```bash
bun install
bun run build
# dist/idea-storage を PATH の通った場所にコピーまたはシンボリックリンク
```

## 使い方

```
idea-storage session run        # セッション走査＋処理
idea-storage session enqueue    # キューに追加
idea-storage session process    # 1件処理
idea-storage session status     # キュー状態表示
idea-storage session retry KEY  # 失敗エントリ再キュー
idea-storage session cleanup    # 孤立エントリ削除
idea-storage extract FILE|UUID  # 会話テキスト抽出
idea-storage launchd            # launchdジョブ登録
```

## 設定

- `~/.config/idea-storage/config.ts` - 設定ファイル
- `~/.config/idea-storage/recipes/recipe-*.md` - レシピ定義

## データパス

| パス | 用途 |
|------|------|
| `~/.config/idea-storage/config.ts` | 設定 |
| `~/.config/idea-storage/recipes/` | レシピ |
| `~/.local/share/idea-storage/` | 生成ファイル |
| `~/.local/state/idea-storage/` | キュー管理 |

## レシピ形式

`config-examples/` のサンプルを参照。Markdown + YAML frontmatter 形式。

## 開発

```bash
bun test          # テスト
bun run typecheck # 型チェック
bun run build     # ビルド
```

## 要件

- Bun
- claude CLI

## ライセンス

MIT
