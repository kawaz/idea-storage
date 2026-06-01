# 2026-06-02: DR-0009 Phase 2 (DB スキーマ単一権限化)

## 達成

DR-0008 / 4 agent zero-base review で Agent C が指摘した「1 DB ファイル × 2 schema
管理者」状態 (queue.db を `queue-internal.applyMigrations` と
`rate-limit-store.initSchema` が独立に open) を解消。

- schema version v1 → v2 に bump し、`rate_limits` を `queue-schema.ts` の管理下に統合
- `rate-limit-store.ts` の `initSchema` / 独自 `getDb` を廃止
- `rate-limit-store.getDb` は `queue-internal.getDb` を呼ぶ薄い wrapper に
- 既存 DB との互換性: v1 DB を開くと自動で v2 にマイグレ。`CREATE TABLE IF NOT EXISTS`
  で既存 `rate_limits` 行は温存
- 起点条件: bun test (808 件 pass) / tsc clean / bun test --isolate (808 pass)
- 完了条件: bun test (新規 2 件追加で 810 件 pass) / tsc clean / bun test --isolate (810 pass)

## 設計判断

### schema version を v2 に bump (案 A 採用)

選択肢:

- **A. v2 にバンプ + v1→v2 migration step** (採用): rate_limits も user_version 管理下
- B. v1 のまま + createSchemaV1 と applyMigrations の v0→v1 path に rate_limits 追加: 既存 v1 DB は新 table を持たないが冪等

A 採用理由: schema の semantic を「user_version が示す状態 = full schema」に保つ。
B にすると「v1 と書かれていても rate_limits の有無が installs ごとに分かれる」歪みが残る。
v0→v1 migration を既に持っている資産があるので、v1→v2 を素直に追加する方が自然。

### rate-limit-store の getDb は wrapper として残す (削除しない)

選択肢:

- A. `getDb` を完全削除して、各関数で `queue-internal.getDb` を直接 import (削除最大化)
- **B. `getDb` は内部 wrapper として残す、`RateLimitStoreDirs` → `QueueDirs` の変換だけ**: (採用)

B 採用理由: `RateLimitStoreDirs = { stateDir }` と `QueueDirs = { queueDir, doneDir, failedDir }` は
形が違う。test が `{ stateDir }` を渡す前提で書かれているため、変換は呼び出し側に
散らすより `rate-limit-store.ts` 内で局所化した方が読みやすい。production の呼び出し元
(session-process / session-convert / session-run / session-status) は `dirs` 引数を
渡さない default 経路なので、影響なし。

### DB ファイル名 (queue.db → state.db) はリネームしない

DR-0009 Phase 2 の「判断事項」で DR 本体が「リネームは後方互換性破壊なので慎重、
本 Phase ではリネームしない方針推奨、後の DR で扱う」と明示済。kawaz の確認なしで
維持。

### `getDb` を module-level singleton にするか (現状維持)

DR-0009 Phase 2 のもう一つの「判断事項」。現状は **毎回 open/close**。

判断: 本 Phase では singleton 化しない。理由:

- 性能改善は計測してない (= 推測ベースの最適化禁則 [[empirical-verification]])
- singleton 化すると test 間で state 漏れの懸念が出る (= mock isolation 弱化)
- 改善が必要なら別 Phase で計測ベースで判断

## 実装

### `src/lib/queue-schema.ts`

- `CURRENT_SCHEMA_VERSION = 2`
- 新規 `createSchemaV2(db)` を追加。`rate_limits` テーブル + `idx_rl_ts` index を `CREATE IF NOT EXISTS` で作成
- `applyMigrations`: 既存の v0→v1 step に加えて v1→v2 step (= `createSchemaV2` をトランザクション内で実行 → `PRAGMA user_version = 2`)

### `src/lib/rate-limit-store.ts`

- `initSchema` 関数を **削除** (= applyMigrations が処理)
- 独自 `resolveDbPath` を **削除**
- 独自 `chmodIfExists` を **削除** (= queue-internal 側で処理)
- `getDb` を `getQueueDb(toQueueDirs(dirs))` の wrapper に変更
- `toQueueDirs(dirs?: RateLimitStoreDirs): QueueDirs | undefined`: `stateDir` から
  `queueDir = ${stateDir}/queue/` を組み立て、`queue-internal.resolveDbPath` が
  `${stateDir}/queue.db` を解決するように
- import 整理: `Database` を type-only に、不要 import (`mkdirSync` / `chmodSync` /
  `dirname` / `join` / `getStateDir`) を削除

## ハマり所

- 既存 `schema migration v0 → v1` テストが `expect(user_version).toBe(1)` で書かれて
  いて 3 件 fail。v2 にバンプしたので `toBe(2)` に置換。意図的な変更なのでテスト更新が筋。
- describe 名も `v0 → v1` から `v0 → v1 → v2` に更新

## 検証

新規追加 test (`queue.test.ts`):

- `fresh DB starts directly at v2`: rate_limits テーブルが含まれる
- `v1 → v2 migration で rate_limits テーブルが追加される`: 手動で構築した v1 DB を
  applyMigrations 経由で開いて user_version=2 + rate_limits 存在を確認
- `v1 → v2 migration で既存 rate_limits 行は温存される`: legacy initSchema 相当で
  rate_limits 行を入れた v1 DB をマイグレ後、行が消えていないことを確認

bun test (3 種完了条件) 後で確認。

## 残課題 (Phase 3 以降)

Phase 3 の本命解体時に:

- `rate-limit-store.ts` の関数群 (`recordObservation` / `getLatestObservations` / `cleanupOldObservations`) を
  `lib/rate-limit/` ディレクトリに移す (Phase 5 で実施想定)
- `RateLimitStoreDirs` 型と `QueueDirs` 型の二重化は Phase 7 (型 colocate + QueueDirs
  廃止) で解消

## 関連

- 起点: `docs/decisions/DR-0009-architecture-refactor-roadmap.md` Phase 2 セクション
- 関連 journal: `docs/journal/2026-06-01-zero-base-review-results.md` (Agent C 問題①)
- Phase 1 本体: `docs/journal/2026-06-01-dr0009-phase1-security.md`
- Phase 1 補強: `docs/journal/2026-06-02-dr0009-phase1-codex-review-fixups.md`
