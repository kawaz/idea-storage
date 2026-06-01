# 2026-06-02: DR-0010 claude-cmux-msg パターン採用 (DR-0006 partial supersede)

## 達成

DR-0006 (= CI で `just build` 強制) の前提が崩れていることに kawaz が指摘して
気付いた。bundle 成果物を誰も使ってないのに CI で build を回すのは本末転倒。

DR-0010 を起こして claude-cmux-msg パターンに揃え、bundle / build を完全廃止。

- `bin/idea-storage`: bash wrapper を新規作成、jj 管理対象として commit
- `idea-storage.plugin.zsh`: zsh プラグインを新規作成、alias 経由で `idea-storage`
  コマンドを提供
- `src/lib/service.ts:getProgramPath()`: `which idea-storage` を廃止し、
  `import.meta.dir` から repo root を resolve する形に
- `scripts/build.ts` / `justfile build` task / `package.json scripts.build` /
  CI の build step すべて削除
- `.github/workflows/ci.yml`: 「Build」「Verify build artifact」を削除、
  代わりに `test -x bin/idea-storage` で wrapper の executable bit を検証
- README install 手順を plugin.zsh source 方式に書き換え
- CLAUDE.md の Phase 8 / コマンド一覧を整合
- DR-0006 末尾に supersede note 追加、INDEX.md 更新
- DR-0009 Phase 8 の対象を訂正 (= VERSION / release.yml / homebrew tap /
  CHANGELOG は不採用とスコープアウト明示)

## ハマり所 / 反省

### 1. 「ビルドして使わないのに CI でビルドしてる」本末転倒の見落とし

- DR-0006 の文面 (「CI で build を必須化」) を rule として受け取り、配布フローが
  あるかどうかの確認をせずに「build は要件」と決め込んだ
- kawaz の DR-0009 Phase 8 案にあった「VERSION + release.yml + homebrew tap」を
  そのまま受け入れ、配布物がない事実を無視した
- 教訓: rule / DR の文面より、**実際の運用** (= 配布物の有無、CI 成果物の使い道)
  を観察して妥当性を疑う

### 2. 暴走した訂正の方向ミス

kawaz の「ビルドも不要」発言を受けて、私は `src/index.ts` に shebang を付ける
方式 (= bun shebang 直接実行) に走った。だが kawaz の想定は **claude-cmux-msg
パターン** (= bash wrapper + plugin.zsh) だった。

- kawaz の「bin とかなかったか?」「パス通さない」「zsh プラグインコードが付いてる」
  発言の意味を最初に正しく拾えなかった
- 別リポ (cmux-msg) の実物を見れば即座にパターンがわかったが、それを後回しに
  した
- 教訓: kawaz の運用パターン質問は **既存リポの実物** を見て確認するのが最短

### 3. `which idea-storage` の存在意義の誤解

- 「`which` を成功させること」が目的じゃなく「**プロジェクトディレクトリの絶対
  パスを取ること**」が目的、と kawaz が指摘
- bash wrapper も TypeScript も自分のスクリプト位置を知る経路を持っている
  (`${BASH_SOURCE[0]}` / `import.meta.dir`)。外部 (= `which`) に聞く必要なし
- 教訓: **「自分が誰か自分で知る」** を最初に検討する。外部に問い合わせる API は
  alias / PATH / 環境変数依存になりがちで brittle

## 設計判断 (DR-0010 の要点だけ再掲)

- **bundle / dist/ / build 廃止**: bun runtime 前提 + 配布物無し → bundle の
  意味なし
- **bash wrapper + plugin.zsh 採用**: 同パターンが cmux-msg で実証済、CSA とも
  互換性ある (CSA は bundle commit 方式だが、根本の plugin.zsh + bin/<name> 構造
  は同じ)
- **shebang スクリプト方式は不採用**: src tree に実行権限ファイル混在は構造の
  混乱、claude-cmux-msg パターンとも不一致
- **CSA パターン (bin/ にバンドル commit) も不採用**: idea-storage は bun-only
  なので bundle して runtime 不要にできない、commit する差分が太る

## 検証

- `./bin/idea-storage --version` → `0.1.0` (= bash wrapper 起動成功)
- `bun test` → 822 pass / 0 fail (= service.ts 変更が他に影響なし)
- `bunx tsc --noEmit` → clean
- `just check` → 全 pass (test + typecheck + lint + fmt-check)
- CI の `Verify shell wrapper is executable` (= `test -x bin/idea-storage`) は
  bin/idea-storage が executable bit 付きで commit されていれば成功

## 移行手順 (kawaz 手元作業、CLAUDE.md / DR-0010 参照)

1. `rm ~/.local/bin/idea-storage` (= 古い symlink 削除)
2. zsh plugin として読み込む (= `.zshrc` で source か zinit/antidote/...)
3. `idea-storage service register` 再実行 (= 新 plist が `bin/idea-storage`
   絶対パスを指すように更新)
4. `rm -rf dist/` (= 古い build 成果物削除)

## 関連

- DR-0010: 本変更の正本記録
- DR-0006: partial supersede 対象 (CI build 強制部分)
- DR-0009 Phase 8: 「運用整備」の完了範囲を訂正、claude-cmux-msg パターン採用と
  整合
- `kawaz/claude-cmux-msg`: 参考実装の canonical
- `kawaz/claude-session-analysis`: bin/ bundle commit パターン (本 DR では不採用)
- 旧 journal `2026-06-02-dr0009-phase7-8-partial.md`: 「Phase 8 残課題」記述は
  本 journal で訂正済 (= VERSION / release.yml / homebrew tap / CHANGELOG は
  全部不採用)
