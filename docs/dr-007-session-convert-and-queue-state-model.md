# DR-007: session convert subcommand and queue state model extension

## 背景

queue は newest-first で dequeue する設計（DR-004 / `feedback_dequeue_newest_first.md`）のため、新規エンキューが続くと古いセッションのレシピが永遠に処理されない構造的な問題があった。さらに「特定の (session, recipe) を明示的に再変換したい」というニーズに対し、CLI からそれを指示する手段が存在しなかった。

加えて、worker を並列で動かしたい / CLI 経由で手動再変換したい場合に、同じ (session, recipe) を二重処理するレースを防ぐ機構が無かった（旧設計は dequeue = `DELETE` で取り出してから処理する形式）。

これらをまとめて解決するため、queue の state モデルとスキーマ全体を再設計し、`session convert` サブコマンドを追加する。

## 主要な設計判断

### 1. key 文字列 API の廃止

| 案                                          | 利点                      | 欠点                                               | 判断 |
| ------------------------------------------- | ------------------------- | -------------------------------------------------- | ---- |
| 旧: `<sessionId>.<recipeName>` の文字列 key | 後方互換                  | key に意味を持たせる設計、別軸で分離した方が正しい | ✗    |
| 新: `(sessionId, recipeName)` を引数に取る  | 意味のある2軸を素直に表現 | 破壊的変更                                         | ✓    |

内部スキーマも `session_pk + recipe_pk` の UNIQUE 制約に変更。パーソナルツールであり、後方互換だけのために設計を歪める価値はない（`design-priority.md`「コストではなく設計上の優位性で説明」）。

### 2. 状態モデルの拡張

旧: `queued | done | failed` → 新: `queued | processing | done | failed | skipped`

| 案                             | 利点                                                | 欠点                                                                                     | 判断 |
| ------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| 単一 status カラム拡張（採用） | SQL が status 単独 WHERE で書ける、運用クエリが素直 | 状態数が増える                                                                           | ✓    |
| 2軸モデル (state + outcome)    | 概念的に直交                                        | `WHERE state='done' AND outcome='ok'` のような複合 WHERE が常時必要、運用 SQL が煩雑     | ✗    |
| skipped を done に潰す         | 状態数を抑えられる                                  | 「成果物がある done」と「中身ゴミの done」を毎回 reason で絞る必要、再処理候補抽出も面倒 | ✗    |

`processing` は排他制御の核。dequeue を `DELETE` から `UPDATE status='queued' → 'processing'` に変更することで、worker クラッシュ後の orphan 検知（再開可能性の保持）も同じレーンで扱える。

`skipped` は一級市民として表現する。「再処理候補を絞る」「成功率を集計する」のクエリが status 単独 WHERE で書けるため。

### 3. `reason` カラムの一般化

旧 `fail_reason TEXT`（failed 専用）→ 新 `reason TEXT`（done/failed/skipped 共通の最終ステータス理由フリーテキスト）。

接頭辞慣習: `empty_session: 0 lines` / `no_user_turns` / `no_conversation` / `fork_no_new_conversation` / `already_processed` 等。

不採用案:

- **reason を列挙化（ENUM 相当の CHECK 制約）**: 拡張のたびにスキーマ変更が必要。フリーテキスト + 接頭辞慣習で十分柔軟。
- **queue_entries.reason を廃止し history.message のみに集約**: 「最新の理由」を取るために毎回 history JOIN が必要になり運用 SQL が煩雑。queue_entries 側にも最終理由を持たせる重複は意図的に許容。

### 4. `history` テーブルの新設

`(timestamp, session_pk, recipe_pk, action, message)` の append-only ログ。

`action`: `enqueued | claimed | completed | failed | skipped | reset`

queue_entries.reason との情報重複は意図的:

- queue_entries: 「現在の状態」のスナップショット（JOIN 不要）
- history: 「いつ何が起きたか」の append-only な事実列（運用調査・再処理判断用）

責務が異なるため両方に持つ。状態遷移履歴を queue_entries に同梱しなかったのは、append-only との責務分離が不明確になるため。

### 5. sessions / recipes テーブルの正規化

旧: queue_entries や各テーブルが `session_id` (TEXT 36) を都度持つ。
新: `sessions(uuid)` / `recipes(name)` を独立テーブルに切り出し、queue_entries / history は INTEGER FK (`session_pk`, `recipe_pk`) で参照。

理由:

- history が育つ前提でストレージ最適化（INTEGER FK は TEXT(36) より遥かに軽量）
- JOIN 化のコストは INDEX で吸収可能

不採用:

- **`session_id` を BLOB(16) で保存**: 可読性ゼロで `sqlite3` で直接覗けないコストが大きい
- **`session_id` を TEXT(32) ハイフン抜き**: 中途半端、UUID の標準形を捨てる利益が薄い

### 6. WHERE 句ガード（defensive UPDATE）

dequeue / claim / その他 status 変更 UPDATE は `WHERE status = '<expected>'` を必ず含める。`db.changes` を見て実際に行が変わったか判定し、0 行ならレース負けとして適切にハンドル（claim 失敗 → waitForCompletion へ分岐）。

### 7. `session convert` サブコマンドの追加

```
idea-storage session convert --session <id> --recipe <name>
```

- claim → 処理 → markDone（既存 worker と同じレールに乗せる、CLI トリガー化）
- claim 失敗（既に他プロセスが processing）→ `waitForCompletion` で完了待ちし、結果を共有
- `recipe.onExisting` は無視して常に強制再実行（`forceProcess=true`）

CLI 専用パスを増やさず、worker と同じ「claim → 処理 → 終了状態書き込み」のレールに統一することで、レース安全性を一本化できる。

## 詳細

### スキーマ概観

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE
);
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE queue_entries (
  session_pk INTEGER NOT NULL REFERENCES sessions(id),
  recipe_pk  INTEGER NOT NULL REFERENCES recipes(id),
  status     TEXT NOT NULL CHECK(status IN ('queued','processing','done','failed','skipped')),
  reason     TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_pk, recipe_pk)
);
CREATE TABLE history (
  ts         INTEGER NOT NULL,
  session_pk INTEGER NOT NULL REFERENCES sessions(id),
  recipe_pk  INTEGER NOT NULL REFERENCES recipes(id),
  action     TEXT NOT NULL,
  message    TEXT
);
PRAGMA user_version = 1;
```

マイグレーションは起動時に `PRAGMA user_version` を見て自動移行。

### claim と waitForCompletion

```ts
// claim: queued → processing への defensive UPDATE
const r = db.run(
  `UPDATE queue_entries SET status='processing', updated_at=?
     WHERE session_pk=? AND recipe_pk=? AND status='queued'`,
  [now, sPk, rPk],
);
if (r.changes === 0) {
  // 他プロセスが先に claim 済み → waitForCompletion で結果共有
}
```

## 結果

該当コミット:

- `feat(session): add convert subcommand for explicit session×recipe conversion`
- `refactor(session-process): extract pure processSession from runProcess`
- `refactor(queue): introduce processing status, change dequeue to UPDATE, add claim/waitForCompletion`（第一弾）
- `refactor(queue): normalize schema with FK, history, skipped status, and reason`（第二弾）
- `refactor(session-cmds): adapt to normalized queue API`（第二弾）

マイグレーション: `PRAGMA user_version = 1`、起動時に自動移行。

実機検証: 並列 `session convert` で claim/wait の 3 経路すべて確認済み:

1. claim 成功 → 自プロセスで処理完了
2. claim 失敗 → 先行プロセスが done になるのを wait → done 結果を共有
3. claim 失敗 → 先行プロセスが failed になるのを wait → failed 結果を共有

残課題: orphan recovery（クラッシュした processing を queued に戻す）は別タスクで対応。
