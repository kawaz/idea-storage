# DR-004: キュー永続化方式の変更

## 現状の問題

1エントリ=1ファイル方式。queue/done/failed の3ディレクトリに 計13,000+ ファイル。

- **enqueue**: 1回で数百〜数千の空ファイル作成（`Bun.write` x N）
- **loadQueueState**: 3ディレクトリの readdir + 全 done/failed ファイルを read（5,000+ I/O）
- **dequeue**: 全 queue ファイルを stat して newest を探す（8,000+ stat）
- **markDone/markFailed**: queue からの unlink + done/failed へのファイル作成

ファイルシステムへの細かい I/O が多く、ディレクトリエントリが肥大化する。

## 候補

### A. SQLite (bun:sqlite)

Bun に組み込みの SQLite ドライバ。追加依存なし。

```sql
CREATE TABLE queue_entries (
  key TEXT PRIMARY KEY,        -- {sessionId}.{recipeName}
  session_id TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | done | failed
  line_count INTEGER,          -- done 時の行数
  retry_count INTEGER DEFAULT 0,
  fail_reason TEXT,
  created_at INTEGER NOT NULL, -- epoch ms
  updated_at INTEGER NOT NULL  -- epoch ms
);
CREATE INDEX idx_status ON queue_entries(status);
CREATE INDEX idx_status_updated ON queue_entries(status, updated_at);
```

| 操作           | 現状                            | SQLite                              |
| -------------- | ------------------------------- | ----------------------------------- |
| enqueue N件    | N回のファイル作成               | 1 transaction, N INSERT OR IGNORE   |
| loadQueueState | readdir x3 + 5000 read          | 1 SELECT (全件)                     |
| dequeue        | readdir + 8000 stat             | 1 SELECT + 1 UPDATE (newest queued) |
| markDone       | unlink + write                  | 1 UPDATE                            |
| markFailed     | unlink + write + read(既存meta) | 1 UPDATE (retry_count++)            |
| getStatus      | readdir x3 + count              | 1 SELECT COUNT GROUP BY status      |
| isDone         | 1 file read                     | 1 SELECT                            |
| isFailed       | 1 file read + 1 stat            | 1 SELECT                            |

利点:

- トランザクションで一括書き込み（enqueue が劇的に高速化）
- dequeue が O(1)（インデックス利用）
- ファイルシステムへの散発的 I/O がなくなる
- WAL モードで読み書き並行可能
- Bun 組み込みで追加依存ゼロ

欠点:

- ファイルベースの透明性がなくなる（ls で状態確認できない）
- DB ファイル破損のリスク（WAL + checkpoint で緩和）
- マイグレーション（既存データの移行）が必要

### B. 単一 NDJSON ファイル

全エントリを1つの NDJSON ファイルに記録。

利点:

- シンプル、人間が読める
- 追記のみで書き込み（append-only）

欠点:

- 状態更新（queued → done）に書き換えが必要 → 全ファイル読み書き or compaction
- dequeue で全件スキャンが必要（インデックスなし）
- ファイルサイズが肥大化
- 並行アクセスでのデータ破損リスク

### C. 単一 JSON ファイル

全状態を1つの JSON オブジェクトで管理。

利点:

- 最もシンプル
- 人間が読める

欠点:

- 全件読み込み → 更新 → 全件書き込みが毎操作で発生
- 13,000+ エントリの JSON シリアライズ/デシリアライズは軽くない
- アトミック書き込みが必要（一時ファイル + rename）
- loadQueueState は O(1) だが、個別操作のコストが高い

### D. ファイルベース改善（現状ベース）

- enqueue を batch 化（複数ファイルを一括作成）
- dequeue でソート済みキャッシュを利用
- done/failed のファイル内容をファイル名にエンコード

利点:

- 既存コードからの変更が最小

欠点:

- 本質的な問題（ファイル数の肥大化）は解決しない
- ディレクトリの readdir コストは変わらない

## 決定: A. SQLite

理由:

1. **I/O パターンとの親和性**: enqueue の一括 INSERT、dequeue のインデックス引き、状態更新の UPDATE — 全てが RDB の得意パターン
2. **Bun 組み込み**: `bun:sqlite` で追加依存ゼロ。同期 API で使いやすい
3. **トランザクション**: enqueue で数百件の INSERT をトランザクションでまとめられる
4. **将来の拡張**: クエリの柔軟性（例: recipe 別の統計、古い done エントリの自動クリーンアップ）
5. **B, C の欠点**: 全件読み書きのコストが高く、ファイルサイズ肥大化の問題がある
6. **D の限界**: ファイルシステムの根本的な制約を回避できない

NDJSON (B) は append-only ログには向くが、状態管理（queued→done の遷移）には不向き。
JSON (C) は小規模なら良いが、13,000+ エントリでは毎回の全件シリアライズが重い。

## 不採用技術の理由

- **NDJSON**: 状態遷移の表現が苦手。compaction が必要になり複雑化する
- **単一JSON**: 全件読み書きのコストが O(N) で、N が大きい本ケースでは不適切
- **ファイルベース改善**: 根本的な問題（ディレクトリ内のファイル数）を解決できない
- **LevelDB/RocksDB 等**: Bun にネイティブドライバがなく、追加依存が必要

## マイグレーション方針

- 初回起動時に queue/done/failed ディレクトリの既存ファイルを SQLite に取り込む
- マイグレーション完了後、旧ディレクトリは `.bak` にリネーム（ロールバック用）
- 次回以降は SQLite のみ使用

## DB ファイルパス

`~/.local/state/idea-storage/queue.db`（XDG State Directory 準拠）

## 設計判断メモ

### dequeue の排他制御

dequeue は SELECT + DELETE で実装。並行実行時の二重取得は lockfile（session-run.lock）で防止する。
`processing` ステータスを導入しない理由: session-run は単一プロセスで動作する設計であり、lock 取得なしに dequeue されることはない。DB レベルの排他制御は過剰。

### マイグレーション時の状態衝突

同一 key が queue/ と done/ の両方に存在する場合（旧実装の markDone で queue 削除と done 書き込みの間にクラッシュした場合等）、done を優先する。
取り込み順序: done → queue（done にある key は queue からスキップ）→ failed。

### session-process.ts の done 参照

旧実装では session-process.ts が done ファイルを直接読んでいた（onExisting 判定）。
SQLite 移行に伴い、queue.ts の `getDoneLineCount()` API を追加して置換済み。
