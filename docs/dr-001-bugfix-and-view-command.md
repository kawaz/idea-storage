# DR-001: バグ修正と view サブコマンド追加

## 背景

TypeScript/Bunリファクタリング完了後、以下の問題が発見された：
- getRecipesDir() が存在しない recipes/ サブディレクトリを参照（修正済み）
- launchdが旧シェルスクリプトを参照（修正済み）
- session-process.ts でセッションファイル未発見時にmarkFailed()が呼ばれない

加えて、日誌ビューア機能の要望がある。

## 修正

### session-process.ts: ファイル未発見時のハンドリング

現在: セッションファイルが見つからない → `return true`（スルー）
問題: dequeue()でキューから削除済みだがmarkDone/markFailedが呼ばれず、次回enqueueで再キュー → 無限ループ
修正: markFailed() を呼んでfailed/に記録する

## 新機能: view サブコマンド

### 概要

fzf + mdp ベースのTUI日誌ビューア。

### 仕様

- dataDir以下の全 .md ファイルを走査
- fzf で一覧表示（3列: 行数, レシピ名, ファイル名）
  - yyyy/mm/dd のパス部分はファイル名に含まれているので不要
- 右側に mdp でプレビュー表示
- ctrl-o で `mdp /path/to/file.md | less -R` を全画面起動
- PAGER終了後リスト画面に戻る

### 実装方針

- src/commands/view.ts として実装
- gunshiコマンドとして index.ts に登録
- fzfのオプションは kawaz/zsh-history-duckdb のパターンを参考:
  - --with-nth でフィールド選択
  - --preview で mdp 実行
  - --bind "ctrl-o:execute(...)" で全画面表示
- Bun.spawn() で fzf プロセスを起動、stdin/stdout を inherit
