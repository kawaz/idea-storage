# DR-005: Rate Limits を考慮した自律スキップ

## 背景

idea-storage の worker はユーザのアイドル時間に変換処理を行うバックグラウンドジョブ。ユーザ自身が Claude Code を激しく使っているタイミングで処理を続けると、ユーザのメイン利用の 5 時間/7 日リミットを圧迫してしまう。

ユーザのメイン利用を邪魔しないよう、rate_limit の残量を観察して「余裕があるタイミングだけ動く」挙動を実装する。

## スキップ条件

5h バケツ・7d バケツそれぞれについて次を評価し、**どちらか一方でも該当**すれば skip（即 exit）:

```
skip if (token_util% > 30% || elapsed% > 30%) && token_util% > elapsed% * 0.9
```

意図:
- **ウィンドウ序盤**（双方 30% 以下）は常に動く
- **中盤以降**、ユーザの消費ペースが経過時間より速い（=メイン利用が激しい）なら譲る

`elapsed%` はウィンドウの経過率: `(now - windowStart) / windowLengthSec * 100`。`windowStart = resets_at - windowLengthSec`。

将来的に velocity/acceleration を使った予測も加える（後述）。

## rate_limit 取得方法

### 検討経路

| 経路 | コスト | 安定性 | 判断 |
|---|---|---|---|
| A. `/api/oauth/usage` 直叩き | 低 | 認証エンドポイント throttle が厳しい（429 `retry-after: 3000+`）。claude 本体が使っていない | ✗ |
| B. `/v1/messages` probe + レスポンスヘッダ | 1 コール分 | 安定（claude 本体が使う経路） | △ |
| C. statusline hook でダンプ | 0 | ユーザが対話セッションを開いている時しか発火しない | ✗ |
| D. stream-json `rate_limit_event` | 0（既存コールに相乗り） | `status` と `resetsAt` のみで `utilization` が欠落 | ✗ |
| E. `ANTHROPIC_LOG=debug` stdout ヘッダ | 0（既存コールに相乗り） | claude 自身のレスポンスヘッダが生で露出 | ✓ |

### 採用: E. ANTHROPIC_LOG=debug

`ANTHROPIC_LOG=debug claude -p ...` を実行すると stdout に debug ログが混入し、その中に `/v1/messages` のレスポンスヘッダ全部が含まれる:

```
"anthropic-ratelimit-unified-5h-utilization": "0.13"
"anthropic-ratelimit-unified-5h-reset": "1776056400"
"anthropic-ratelimit-unified-5h-status": "allowed"
"anthropic-ratelimit-unified-7d-utilization": "0.02"
"anthropic-ratelimit-unified-7d-reset": "1776646800"
"anthropic-ratelimit-unified-7d-status": "allowed"
```

idea-storage の worker は**どのみち処理で claude を呼ぶ**ので、その呼び出しに `ANTHROPIC_LOG=debug` を付与してヘッダを抽出すれば**追加コスト0**で rate_limits を得られる。

### 不採用理由

- **A (`/api/oauth/usage`)**: 連続呼び出しで即 429。`retry-after: 3000+` が返り、数分おきのサンプリングに耐えない。claude 本体が使わない経路なので長期安定性も不透明。
- **C (statusline)**: 対話セッション起動時しか発火しない。非対話ワーカーからは使えない。ユーザも「statusline 側を汚したくない」旨表明。
- **D (stream-json event)**: `status:"allowed"/"warning"/"rate_limited"` の粗い状態しか出ず、`(token% > elapsed% * 0.9)` のような percentage 判定に必要な値が取れない。

## 観測点の設計

### 主経路: worker の既存コールに相乗り

`src/lib/claude-runner.ts` の `runClaude()` で `ANTHROPIC_LOG=debug` 環境変数を付与。stdout を行単位で読み、:

1. `"anthropic-ratelimit-unified-*"` マッチ行を **parse して store に追記**
2. `result` JSON 行はそのまま結果として返却

debug ログ混入による既存 parse 影響への対策:
- `claude -p --output-format json/stream-json` の結果は明確に JSON フォーマット
- debug ログ行は `[log_xxxxx]` prefix または `{method: "post", ...}` 形式
- 既存コードは `JSON.parse` しているので混入行で壊れる可能性 → stdout を行ごとに読み、**最後の valid JSON 行のみ結果として採用**、その他はヘッダ抽出の副作用に使う

### 将来の補助経路: 軽量 probe

worker がアイドル時に velocity/acceleration 計算のための追加サンプルが欲しい場合に、Haiku + 最小プロンプト（`--max-tokens 1` 相当）で probe。

ただし初期実装では入れない。worker の既存コールだけでサンプルが集まる想定。必要性が見えたら追加。

## 保存: SQLite (queue.db) に同居

既存の `~/.local/state/idea-storage/queue.db` にテーブル追加。

```sql
CREATE TABLE rate_limits (
  ts INTEGER PRIMARY KEY,          -- 観測時刻 epoch seconds
  five_hour_util REAL,             -- 0.0 - 1.0
  five_hour_reset INTEGER,         -- resets_at epoch
  five_hour_status TEXT,           -- "allowed" | "warning" | "rate_limited" 等
  seven_day_util REAL,
  seven_day_reset INTEGER,
  seven_day_status TEXT,
  source TEXT NOT NULL             -- "worker" | "probe"
);
CREATE INDEX idx_rl_ts ON rate_limits(ts DESC);
```

別ファイルにせず queue.db に同居する理由:
- 観測と worker のタスク状況は相関が強く、同じ DB で扱いたい場合に便利
- ファイル管理が増えない
- `WAL` モードなら読み書き並行可能

## クリーンアップ戦略

長期ログが肥大化しないよう、**2 段階保持**:

1. **直近 24h**: 生サンプル全保持（velocity/acceleration に必要な密度）
2. **24h〜8d**: 1時間毎に1サンプルに集約（長期傾向のみ）
3. **8d 以上**: 削除

7d バケツの cycle（最大 7日）+ 1日余裕で 8d を閾値とする。

### 発火タイミング

- worker 起動時 (`session run` の先頭)
- 処理 N 件毎にも呼ぶ（worker が 1 時間連続稼働するケース対策）

### クリーンアップ SQL

```sql
-- Stage 1: 8d より古いものは削除
DELETE FROM rate_limits WHERE ts < (strftime('%s','now') - 8*86400);

-- Stage 2: 24h〜8d の区間で、1時間毎の最新のみ残す
DELETE FROM rate_limits
WHERE ts < (strftime('%s','now') - 86400)
  AND ts NOT IN (
    SELECT MAX(ts) FROM rate_limits
    WHERE ts < (strftime('%s','now') - 86400)
    GROUP BY ts / 3600
  );
```

## 判定の拡張（Phase 2）

時系列から `velocity`（util / time）と `acceleration` を算出:

- 直近 3 点から最小二乗で `velocity`（%/min）
- 直近 6 点から前半 3 点・後半 3 点の velocity 差で `acceleration`

追加スキップ条件（OR 結合）:
- `projected = util + velocity × remainingTime > 95%` — ペースだと枯渇必至
- `acceleration > 0 && util > 50%` — 加速中かつ過半数 → 譲る

追加 proceed 許可（直近 10 分 velocity ≈ 0 ならベース条件超えでも動く）はリスクがあるので初期は入れない。

## 安定性への備え

- `ANTHROPIC_LOG` の出力形式変化に備え、ヘッダ抽出は**ヘッダ名マッチ**（"anthropic-ratelimit-unified-*"）で実装
- ヘッダが取れなかったコールは **サイレント記録スキップ**（処理自体は止めない）
- 新ヘッダ追加は無視（unknown keys を許容）
- ヘッダ名リネーム等の破壊的変更時は worker の判定が保守的（=skip）側にブレることを確認（テストで担保）

## 将来検討

- worker 以外の独立 probe（軽量）で velocity を密にサンプリング
- GUI で現在の rate_limits / skip 状況を可視化
- session 単位で `should_skip_reason` を記録し、後追いで分析可能に
