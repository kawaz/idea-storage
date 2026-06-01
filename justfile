# idea-storage

default: check

# bun で直接実行（引数をそのまま渡す）
run *ARGS:
    bun run src/index.ts {{ARGS}}

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

push: check
    jj git push

service-register:
    idea-storage service register
