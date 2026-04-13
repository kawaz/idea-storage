# idea-storage

default: build test

# bun で直接実行（引数をそのまま渡す）
run *ARGS:
    bun run src/index.ts {{ARGS}}

build:
    bun run scripts/build.ts

test:
    bun test

typecheck:
    bunx tsc --noEmit

lint:
    bunx oxlint

fmt:
    bunx oxfmt

fmt-check:
    bunx oxfmt --check

check: test typecheck lint fmt-check

# バンドル整合性チェック（ビルドし直して差分があれば失敗）
# dist/ は .gitignore されているため jj diff には出ない。stderr の Warning を
# 除外し、"0 files changed" 行は差分なし扱いにする。
build-check: build
    jj diff --stat dist/ --no-pager 2>/dev/null | grep -v '^0 files changed' | grep -q . && { echo "ERROR: バンドルが最新ではありません。ビルド結果をコミットしてください。" >&2; exit 1; } || true

push: check build-check
    jj git push

service-register:
    idea-storage service register
