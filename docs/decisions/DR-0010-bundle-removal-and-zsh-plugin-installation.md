# DR-0010: bundle 廃止 + claude-cmux-msg パターン install への移行

Status: accepted (2026-06-02)
Supersedes: [DR-0006](DR-0006-ci-with-github-actions.md) (= CI で `just build`
強制 + `test -x dist/idea-storage` を必須化していた部分)

## 背景

DR-0006 で「CI で `just build` を必須化し、`dist/idea-storage` の build 可能性を
強制する」と決定していた。当時の前提:

- `dist/idea-storage` を build → kawaz 手元で `~/.local/bin/idea-storage` に
  symlink → PATH 上のコマンドとして使う運用を想定
- CI で build を回さないと「ビルド可能性」が壊れたまま push される懸念があった

しかし運用が動き始めると以下のミスマッチが見えた:

1. `dist/idea-storage` は **リポに commit されていない** (= .gitignore 済)。
   build 成果物は配布されず、ユーザは clone 後に `bun run build` を走らせる必要が
   ある。だが「ユーザ」は実質 kawaz 1 人のローカル運用
2. bun runtime は **どっちみち必須** (= claude / CSA 経由 + bun:sqlite 等の Bun
   API を使うため)。bundle しても起動時に bun が必要なら shebang スクリプト経由
   と本質的に同じ
3. CI が build しても artifact を破棄するだけ (= テスト後の `test -x dist/idea-storage`
   で executable bit を確認するのみ)。**「ビルドして使わないのに CI でビルドして
   いる」本末転倒**
4. kawaz の他リポ (`kawaz/claude-cmux-msg`) は同じ「bun runtime 前提 CLI」を
   **bash wrapper + plugin.zsh alias** 方式で運用しており、bundle なし。
   idea-storage もこのパターンを採用するつもりだったが未実装で、間に合わせの
   build + symlink 運用が残存していた

## 決定

**bundle / dist/ / build / CI build step を廃止し、claude-cmux-msg パターンに揃える**:

- `bin/idea-storage`: bash wrapper を jj 管理対象として追加。`${BASH_SOURCE[0]}`
  から自分のディレクトリ → 親 (リポ root) → `src/index.ts` を resolve、`bun run`
  で exec
- `idea-storage.plugin.zsh`: zsh プラグインとして source される。
  `alias idea-storage="${0:h}/bin/idea-storage"` で interactive shell に alias 提供
- `scripts/build.ts`: 削除
- `justfile`: `build` task と `default: build test` を削除、`default: check` に
- `package.json`: `scripts.build` を削除
- `.github/workflows/ci.yml`: `just build` step と `test -x dist/idea-storage` step を
  削除、代わりに `test -x bin/idea-storage` で wrapper の executable bit を検証
- `src/lib/service.ts:getProgramPath()`: `which idea-storage` 経路を廃止。
  `import.meta.dir` から repo root を resolve して `${repoRoot}/bin/idea-storage`
  を返す (= alias / PATH / which に依存しない、自分が誰か自分で知っている)

## 採用理由

### A. bundle 不要

- 配布物が存在しない (= kawaz 個人用ローカルツール、外部ユーザいない)
- bun runtime が必須なので bundle しても意味なし (bun が無ければそもそも動かない)
- bundle なしの方が起動も差分も simple

### B. claude-cmux-msg パターンとの統一

- 同じ「bun runtime 前提の CLI」を kawaz リポで二通り運用するのは保守コスト
- bash wrapper + plugin.zsh 方式は CSA / cmux-msg で実証済
- alias は zsh plugin manager 経由で配布物としても自然 (= `zinit light kawaz/idea-storage`)

### C. 自分のパスは自分で知る

- bash wrapper / TypeScript の双方が自分のスクリプト位置を knowing なので、
  `which` 経由で外部に問い合わせる必要なし
- launchd plist に書く絶対パスは `import.meta.dir` 起点で計算可能

## 不採用案

### `bin/idea-storage` をコンパイル済みバイナリとして commit する (= CSA パターン)

CSA (`bin/claude-session-analysis`) はこの方式。利点は clone 直後に動く + bun が
無くても動く。

不採用理由:

- idea-storage は bun-only な API (`bun:sqlite`, `Bun.spawn`, etc) を直接使う構造、
  bun runtime が必須要件。コンパイル成果物にしても bun runtime が不要になるわけでは
  ない (= Bun.compile で single-file 実行可能だがランタイム同梱は不要)
- bundle 成果物を毎回 commit するのは差分が太る + `check-bundle` 強制の保守コスト
- 開発スピード優先 (= 個人 OSS、配布物無しなので)

### shebang スクリプト方式 (`src/index.ts` に `#!/usr/bin/env bun`)

直接 `src/index.ts` を実行可能ファイルにする案。

不採用理由:

- src tree に実行権限ファイルが混ざる (= `chmod +x src/index.ts`) のは構造の混乱
- claude-cmux-msg パターンと整合しない (= 同じパターンを kawaz リポで採用していたら
  揃える方が筋)
- bash wrapper を経由した方が「bun が無いときに親切なエラーメッセージを出せる」

## 移行手順 (kawaz 手元作業)

1. 既存 `~/.local/bin/idea-storage` symlink を **削除**: `rm ~/.local/bin/idea-storage`
2. zsh plugin として読み込む (zinit / antidote / 手動 source のいずれか):
   ```zsh
   # 手動 source 例 (.zshrc)
   source /Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main/idea-storage.plugin.zsh
   ```
3. launchd 再登録: `idea-storage service register` を再実行。`getProgramPath()`
   が更新されたので、新 plist は `bin/idea-storage` の絶対パスを指す
4. 既存 `dist/idea-storage` (= 古い build 成果物) は削除可: `rm -rf dist/`

## 検証

- `./bin/idea-storage --version` → `0.1.0` (= bash wrapper 経由で起動成功)
- `bun test`: 全 pass (= service.ts の変更が他に影響なし)
- `bunx tsc --noEmit`: clean
- CI: `just build` step 削除後も他の step (test / typecheck / lint / fmt-check)
  - `test -x bin/idea-storage` が成功すること

## 関連

- DR-0006: 本 DR で supersede (= 「CI で `just build` 必須」の方針を破棄)
- DR-0009 Phase 8: 運用整備の完了範囲を本 DR で確定
- `kawaz/claude-cmux-msg`: 参考実装 (bash wrapper + plugin.zsh パターンの canonical)
- `kawaz/claude-session-analysis`: bin/ コンパイル成果物 commit パターン (= 本 DR では
  不採用とした選択肢の参考)
