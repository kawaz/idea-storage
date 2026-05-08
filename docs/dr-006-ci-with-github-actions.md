# DR-006: CI/CD with GitHub Actions

## 背景

idea-storage はパーソナルツールだが、サブエージェント並列実装やリファクタの規模が拡大したことで、push 時に手元で `just check` を回すだけでは品質担保しきれない場面が増えた。具体的には:

- サブエージェントが触るファイル範囲が広く、全部のテストを意識して回せないことがある
- 異なる環境（macOS / Linux）での動作を担保したい
- リファクタ後のスキーマ変更などが他リポジトリ依存と乖離していないか CI で確認したい

CI を導入していない状態（`.github/workflows/` 不在）から、`push` / `pull_request` をトリガーに自動チェックを走らせる仕組みを入れる。

## CI サービスの選定

| サービス       | 利点                                                            | 欠点                                      | 判断 |
| -------------- | --------------------------------------------------------------- | ----------------------------------------- | ---- |
| GitHub Actions | リポジトリ統合、`gh` CLI で操作完結、kawaz の他リポジトリで標準 | macOS runner が遅い／高い                 | ✓    |
| CircleCI       | macOS が比較的安価                                              | 別アカウント・別 UI、kawaz の運用と非整合 | ✗    |
| GitLab CI      | 自前ホスト可能                                                  | リポジトリが GitHub 上にあるため二重管理  | ✗    |
| 自前 launchd   | ローカル回せる                                                  | リモート push 時の保証にならない          | ✗    |

### 採用: GitHub Actions

- リポジトリと同じ GitHub 上で完結する。`gh run watch` で結果を即時確認できる
- kawaz/\* の他プロジェクト（authsock-warden、stable-which、cache-warden、port-peeker）が GitHub Actions で揃っており、横展開が効く
- Linux runner は無料枠で足りる（idea-storage はパーソナル用途、頻度が低い）

## ジョブ構成

### 採用: 単一 `check` ジョブ

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - actions/checkout@v4
      - oven-sh/setup-bun@v2 (bun-version: latest)
      - actions/cache@v4 (~/.bun/install/cache)
      - bun install --frozen-lockfile
      - extractions/setup-just@v3
      - just check # test + typecheck + lint + fmt-check
      - just build # dist/idea-storage 生成検証
      - test -x dist/idea-storage
```

### 不採用: ジョブ並列化

経理視点の調査で「`just check` を test/lint/fmt-check で並列化すれば 0.5-1.5 秒短縮」という指摘があったが、不採用。

理由:

- 短縮効果が小さい（CI 全体で 1-2 分台）
- セットアップ（checkout / setup-bun / install）が支配的で、ジョブを増やすほど total minute 消費が増える（並列ジョブは課金的には逆効果）
- 単一ジョブの方が log が一画面で読めて運用しやすい

将来 test 実行時間が極端に伸びた場合は再検討。

### 不採用: matrix で OS 横断

idea-storage は CLI 単体で OS 依存箇所がほぼ無い（bun:sqlite と launchd plist のみ、後者はテスト対象外）。Linux 単発で十分。macOS で動かしたい場合は手元で `just check` を回せば足りる。

## `build-check` の撤廃

旧 justfile に `build-check` ターゲットがあった:

```just
build-check: build
    jj diff --stat dist/ --no-pager 2>/dev/null | grep -v '^0 files changed' | grep -q . && { echo "ERROR: バンドルが最新ではありません。" >&2; exit 1; } || true
```

意図は「バンドル成果物 `dist/idea-storage` を push 前に最新化させる強制」。

しかし `.gitignore` に `dist/` が含まれており、`dist/` は jj 追跡対象外。`jj diff --stat dist/` は常に `0 files changed` を返し、grep が抜けて `|| true` の経路で **常に exit 0** になる。実質ノーオペ。

### 採用: build-check 撤廃 + CI で `just build` を必須化

- justfile から `build-check` ターゲットを削除
- `push` ターゲットの依存から `build-check` を外す
- CI ワークフローで `just build` を最後のステップに配置し、ビルド可能性を強制

理由:

- バンドル成果物 (`dist/`) は **配布用ではない**（`bun run src/index.ts` で実行可能）
- 配布が必要になったら別途 release ワークフローを切る（roadmap）
- 「ビルドが通る」ことが本来の関心事 → CI で担保すれば足りる

## permissions 設定

`permissions: contents: read` を最小権限として設定。`pull_request` から走る場合の untrusted input を `run:` ステップに展開しないことで、シェル注入リスクを抑える。

## 結果

- 追加: `.github/workflows/ci.yml`
- 撤廃: `justfile` の `build-check` ターゲット
- ローカル動作: `just check` (550 pass, 0 fail) / `just build` (`dist/idea-storage` 161KB)
- コミット: `vlvrmppx` (`ci: add GitHub Actions workflow and remove obsolete build-check`)

push が走った時点で CI が初回実行される。失敗時は workflow 内容を見直し。
