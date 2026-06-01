# idea-storage.plugin.zsh
#
# zsh plugin として `idea-storage` コマンドを使えるようにする。
# zinit / antidote / oh-my-zsh / antigen / 手動 source 等から source される想定。
#
# 例 (zinit):
#   zinit light kawaz/idea-storage
#
# 例 (手動):
#   source /path/to/idea-storage/idea-storage.plugin.zsh
#
# 実装: 同梱の bin/idea-storage (bash ラッパースクリプト) を alias で指す。
# ラッパーは bun で src/index.ts を直接実行する (bun が必須要件)。

[[ -o interactive ]] || return 0

alias idea-storage="${0:h}/bin/idea-storage"
