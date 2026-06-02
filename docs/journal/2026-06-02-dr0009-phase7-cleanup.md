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

(進行中)

## Commit 3: Phase 6 機械的部分 (DR-0008 §11 切出 + resolved 更新 + INDEX 整合)

(未着手)
