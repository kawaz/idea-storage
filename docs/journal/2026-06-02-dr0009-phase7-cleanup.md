# DR-0009 Phase 7 機械的クリーンアップ進行ログ

Phase 3+4+5 (mock 撤去 + lib/ subdir 化 + テスト責務分割) が main = `18095a7b` で
完了済み。残務のうち kawaz 判断不要な機械的項目を 3 commit に分けて処理する。

## Commit 1: Phase 7 A 束 (型 colocate + QueueDirs 廃止 + paths cleanup)

### 変更内容

- `src/types/index.ts` を解体、各型を所有ドメインに移動:
  - `Recipe` → `src/lib/recipe/recipe.ts`
  - `SessionMeta` → `src/lib/csa/csa.ts`
  - `QueueEntry` → `src/lib/queue/queue.ts`
  - `ConversationMessage` → `src/lib/csa/conversation.ts`
  - `Config` → `src/lib/config.ts`
- `src/types/index.ts` と `src/types/index.test.ts` を削除 (`bun-missing.d.ts` は残す)
- `QueueDirs` 型を queue-internal.ts から削除、全 queue 関数の `dirs?: QueueDirs`
  パラメータも削除 (`getDb()` が `getStateDir()` のみ参照)
- `RateLimitStoreDirs` も廃止、`toQueueDirs` 経由していたコードを撤去
- `paths.ts` の deprecated 3 関数 (`getQueueDir` / `getDoneDir` / `getFailedDir`)
  を削除し、migrate-queue.ts 内 private な `legacyDirs()` に格下げ
- test ファイル群 (queue.test, queue-state.test, queue-schema-migration.test,
  migrate-queue.test, rate-limit-store.test) を `XDG_STATE_HOME` を直接
  override する beforeEach/afterEach パターンに切替

### ハマり所

- **isFailed の引数順**: `(sessionId, recipeName, dirs?, retryOpts?)` だったので
  `dirs?` を削るだけだと `retryOpts` の位置がずれる。テスト側も同時に修正必要
  (advisor の事前指摘により予防済)
- **migrate-queue test の fixture 配置**: legacy dirs は `getStateDir()` 直下に
  なったため、test fixture を `${tempDir}/state/idea-storage/{queue,done,failed}/`
  に書く必要がある (`withIsolatedIdeaStorageEnv` 同等の env 構成)
- **インラインの `import("../types/index.ts").X` 形式**: 通常の `import` 文だけでなく
  test 内のインライン型注釈にも残っており、`sed` で一括置換が必要

### test 数

- baseline: 828 pass / 1629 expect
- Commit 1 後: 817 pass / 1610 expect
- 減少 11 件: 削除した `types/index.test.ts` (8 件) + `paths.test.ts` の
  `getQueueDir` / `getDoneDir` / `getFailedDir` describe ブロック (3 件)

## Commit 2: Phase 7 C 束 (validate 命名 + CliError 統一 + service-log 検証)

### 変更内容

- `src/lib/validate.ts` の関数を CLI 厳格用と内部 lazy 用で名前を分離:
  - `validateSessionId` → `assertCliSessionId` (lib/validate.ts)
  - `validateRecipeName` → `assertCliRecipeName` (lib/validate.ts)
  - `validateSessionId` → `validateStoredSessionId` (lib/queue/queue-internal.ts)
  - `validateRecipeName` → `validateStoredRecipeName` (lib/queue/queue-internal.ts)
- `exitWithError(...)` を全廃。caller は `throw new CliError(...)` に切替:
  - `src/commands/session-retry.ts` (引数チェック + try/catch ラップ)
  - `src/commands/session-convert.ts` (try/catch ラップ)
  - `src/commands/extract.ts` (`Session not found`)
  - `src/commands/service-register.ts` (launchctl bootstrap 失敗)
  - `src/commands/service-unregister.ts` (bootout 失敗 + try/catch ラップ)
  - `src/commands/service-log.ts` (existsSync 失敗を `console.error + process.exit(1)`
    から `throw CliError` に揃える)
- **トップレベル catch ハンドラを `src/index.ts` に新設** (= advisor 指摘):
  CliError なら exit code を伝搬、それ以外は再 throw して bun のデフォルト
  クラッシュ表示。これがないと finally / cleanup を回す目的が崩れる。
- `errors.ts` の `exitWithError` 関数本体 + `errors.test.ts` の describe ブロック
  (3 件) を削除。
- service-log の `lines` 引数に整数 + 正数バリデーション追加 (`Number.isInteger`
  - `<= 0` チェック)。

### ハマり所

- **トップレベル catch が必須**: 単に `process.exit` → `throw CliError` に
  置換すると、catch がなければ uncaught throw でプロセス異常終了 + stack 出力
  になる。advisor の事前指摘がなければ気付くのに 1 サイクル余分にかかっていた。
- **queue-internal の自己参照**: validate 関数を rename した瞬間、queue-internal.ts
  内の `getOrCreateSessionPk` / `getOrCreateRecipePk` も rename 対象になる
  (内部から内部を呼んでいる)。一括 sed が効くケース。
- **`queue.ts` の re-export**: queue.ts は internal の旧名を re-export して
  外部 caller (queue.test.ts など) が使っていた → 同名 sed で test ファイルも
  追従が必要。
- **`service-unregister.ts` の try/catch**: `exitWithError` を `throw CliError`
  に置換すると、enclosing try が CliError ごと catch してしまう。CliError なら
  そのまま rethrow するガードを catch 側に入れる必要があった。

### test 数

- Commit 1 後: 817 pass
- Commit 2 後: 814 pass (errors.test.ts の `exitWithError` describe 3 件削除)

## Commit 3: Phase 6 機械的部分 (DR-0008 §11 切出 + resolved 更新 + INDEX 整合)

### 変更内容

- `docs/issue/2026-06-02-skipped-breakdown-30day-window.md` を新規:
  `getSkippedBreakdown()` が現在 lifetime 全件集計しているのを 30 日窓に
  絞る issue。
- `docs/issue/2026-06-02-dispatcher-fallback-and-quality-gate-rates.md` を新規:
  DR-0008 §11 の `dispatcher fallback rate` / `quality gate rejection rate` /
  `effective filter pass rate` を `session status` に追加する issue。
- `DR-0008` 末尾の「mock 撤去は別 PR で対応予定」記述を打ち消し線 +
  **resolved (DR-0009 Phase 3 step 3-e+f, 2026-06-02)** に更新。
- `DR-0008` の §11 残課題 (last 30 days 窓 / fallback rate / quality rate /
  effective filter rate) に 「`docs/issue/2026-06-02-*.md` に切り出し済」と
  追記。
- `docs/decisions/INDEX.md` の DR-0008 行に `refactored (2026-06-02)` を追加、
  上記 mock 撤去解決 + §11 切り出しを 1 行サマリ化。

### Phase 6 §6 dispatcher 入力スキーマ判断について

未着手。kawaz の判断が必要 (history.dispatch_decided の message JSON を
専用テーブルに正規化するか継続パースか) なので、本 commit には含めない。

### test 数

- Commit 2 後: 814 pass
- Commit 3 後: 814 pass (docs のみの変更、テスト影響なし)

## Commit 4: Phase 7 B-1 (CI workflow + CSA clone を SHA pin)

### 変更内容

- `.github/workflows/ci.yml` の 3rd-party action 4 件を major tag → 特定 SHA pin に:
  - `actions/checkout@v4` → `@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1`
  - `oven-sh/setup-bun@v2` → `@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`
  - `actions/cache@v4` → `@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0`
  - `extractions/setup-just@v3` → `@f8a3cce218d9f83db3a2ecd90e41ac3de6cdfd9b # v3.1.0`
- CSA clone を SHA pin に:
  - `CSA_REPO` / `CSA_SHA` を env で明示、SHA は `7d29ea0b2e6fd7a2a6983fa8dc3c1e71ceaa1466`
    (= 2026-06-02 main HEAD)
  - `git clone --depth 1` 後に `git fetch --depth 1 origin "$CSA_SHA"` + `git checkout`
  - CSA は release tag 無しのため main HEAD ベース、更新が必要なら手動で SHA を bump

### 動機

- 上流 action の major tag は再 retag 可能 (= 攻撃面)。特定 commit SHA に pin することで
  supply chain compromise を不可逆な commit hash で検出可能にする
- CSA は kawaz 個人 OSS だが、CI で main HEAD を盲信するのは同じ supply chain risk

### test 数

- Commit 4 後: 814 pass (CI yml 変更のみ、テスト影響なし)

## Commit 5: Phase 7 B-2 (recent-outputs 増幅警告 + session-jsonl 行サイズ上限ガード)

### 変更内容

- `src/lib/recipe/recent-outputs.ts`:
  - `formatInjectedRecent` の jsdoc に **secrets amplification 注意** を明記。
    N (= 過去出力注入数) を大きくすると過去出力が次プロンプトに再注入される
    surface が広がり、redact pipeline が捕捉できない novel pattern が無限に
    propagate するリスクを明文化。defense layer (write 時 redact + 注入時
    re-redact) も並記、運用上は `n = 3-5` 程度に留めるよう推奨。
- `src/lib/csa/session-jsonl.ts`:
  - `MAX_JSONL_LINE_BYTES = 10 * 1024 * 1024` (10 MiB) を export。
  - `streamSessionLines(filePath, maxLineBytes?)` にオプション引数を追加。
    test では小さい cap (1 KiB) で挙動を再現、production callers は default を使う。
  - 1 行の UTF-8 byte 長が cap を超えた場合は `console.warn` + skip。
    複数行の中で 1 行だけ巨大でも残り行は yield する (= session 全体を捨てない)。
  - 改行が一切来ない adversarial 入力に対しては「`skipUntilNewline` モード」に
    切替、buffer を捨てて memory を bounded に保つ。
  - 末尾 (改行なし最終行) も同様に cap チェック + skip。
- `src/lib/csa/session-jsonl.test.ts`: 3 ケース追加 (`+3 tests`, 全体 814→817):
  - oversized 中間行を skip + warn してもその前後の行は yield されること
  - oversized 末尾行 (no trailing newline) も skip + warn
  - 改行なし巨大入力で in-progress buffer が bounded に保たれること

### 動機

- session-jsonl は **外部入力** (Claude が書き出した session file)。攻撃シナリオは
  限定的だが、disk 上で壊れた session file (= cosmic ray / fs bug) や巨大な
  tool result が含まれる session が来た時に worker process を OOM で落とすのを
  防ぐ。advisor 助言の通り、**全体停止ではなく skip + warn** が正解 (= 1 行
  奇形で session 全体を捨てると pipeline が頓挫する)。
- recent-outputs は code 動作変更なしの jsdoc 強化のみ。コード変更を伴うガードは
  入れず、設計意図 (= 過去出力増幅は redact 2 段では完全には防げない) を明文化。

### test 数

- Commit 5 後: 817 pass (+3 oversized line ケース)
