import {
  formatLogKey,
  getDb,
  getOrCreateRecipePk,
  getOrCreateSessionPk,
  lookupRecipePk,
  lookupSessionPk,
  recordHistory,
  validateRecipeName,
  validateSessionId,
} from "./queue-internal.ts";
import type { QueueStatus } from "./queue-internal.ts";

export interface QueueEntry {
  sessionId: string;
  recipeName: string;
  /** {sessionId}.{recipeName} */
  key: string;
}

/**
 * Public entry point for queue operations.
 *
 * This module owns the *write* API (enqueue / dequeue / claim / mark* / retry /
 * cleanup). Schema definitions live in `queue-schema.ts`, low-level shared
 * helpers in `queue-internal.ts`, and read-only state queries in
 * `queue-state.ts`. We re-export the read-side and shared types from here so
 * existing consumers can keep importing from `./queue.ts` without churn.
 */

// --- Re-exports for backward compatibility ---
//
// External callers import everything from `./queue.ts`. After the split, the
// real definitions live in sibling files; the re-exports below keep the
// public surface stable.

export { CURRENT_SCHEMA_VERSION } from "./queue-schema.ts";
export {
  DEFAULT_RETRY_AFTER_MS,
  formatLogKey,
  getDb,
  validateRecipeName,
  validateSessionId,
} from "./queue-internal.ts";
export type {
  FailedMeta,
  HistoryAction,
  QueueStatus,
  RetryOptions,
  SkippedMeta,
} from "./queue-internal.ts";
export {
  DEFAULT_WAIT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  getDoneLineCount,
  getSkippedBreakdown,
  getStatus,
  isDone,
  isFailed,
  isFailedByState,
  isQueued,
  loadQueueState,
  waitForCompletion,
} from "./queue-state.ts";
export type {
  QueueState,
  QueueStateFailedEntry,
  WaitForCompletionOptions,
  WaitForCompletionResult,
} from "./queue-state.ts";

// --- Queue write API (all functions take sessionId/recipeName, no string keys) ---

/**
 * Skipped 行のうち、新しい line_count が来たら queued に自動復帰させる reason のリスト。
 * `quality_rejected` のような「再実行しても判断が変わらない」ものは含めない (DR-0008 §5.1)。
 *
 * - `no_effective_turn`: PR② 導入。後続追記で effective ターンが現れたら再評価。
 * - `dispatcher_rejected`: PR③ (Phase 2) 導入。後続追記でセッションの性質が変わった
 *   可能性があるので dispatcher を再発火させる。注: 復帰先は元の (session, recipe)
 *   ではなく (session, 'dispatcher') 側で、これは queue.ts ではなく caller 側の責務
 *   (dispatcher のジャッジが reason 単位の再 enqueue を駆動するため、本テーブルでは
 *   復帰可能 reason を宣言するだけにとどめる)。
 */
const REENQUEUABLE_SKIPPED_REASONS: ReadonlySet<string> = new Set([
  "no_effective_turn",
  "dispatcher_rejected",
]);

/**
 * dispatcher を表す internal recipe name。
 * recipe-*.md ファイルとしては存在せず、queue/history の (session, recipe_pk)
 * キーとして使う sentinel。
 *
 * DR-0008 §6: enqueue は effectiveUserTurns >= 1 のとき (session, "dispatcher")
 * を 1 行 queued する。dequeue した worker が recipe_name を見て分岐する。
 */
export const DISPATCHER_RECIPE_NAME = "dispatcher";

/** §5.1 遷移ルール: 既存 status / reason / line_count に対して、新規 lineCount で再 queued すべきか. */
function shouldReenqueue(
  existing: { status: string; reason: string | null; line_count: number | null },
  newLineCount: number,
): boolean {
  const oldLineCount = existing.line_count ?? 0;
  switch (existing.status) {
    case "queued":
    case "processing":
    case "failed":
      // queued / processing: 触らない。failed: DR-0004/0007 既存 retry 機構が別途処理する。
      return false;
    case "done":
      // 追記があれば差分処理のため再 enqueue。
      return newLineCount > oldLineCount;
    case "skipped": {
      // 復帰対象 reason のみ、追記があれば queued に戻す。
      if (!existing.reason || !REENQUEUABLE_SKIPPED_REASONS.has(existing.reason)) return false;
      return newLineCount > oldLineCount;
    }
    default:
      return false;
  }
}

/**
 * 複数のエントリを 1 トランザクションで一括 enqueue する。
 *
 * §5.1 遷移ルール:
 * - 行なし → 新規 queued
 * - 既存 queued / processing → 触らない
 * - 既存 done / skipped(reason ∈ REENQUEUABLE_SKIPPED_REASONS) で `lineCount > old` → queued に再遷移
 * - failed → 既存 retry 機構に委譲 (このパス上では触らない)
 * - skipped(`quality_rejected` 等の永続) → 触らない
 *
 * バリデーションはトランザクション開始前に全件チェックするため、
 * 1 件でも不正があればどのエントリも挿入/更新されない。
 */
export function enqueueBatch(
  entries: Array<{ sessionId: string; recipeName: string; lineCount: number }>,
): void {
  if (entries.length === 0) return;
  for (const { sessionId, recipeName } of entries) {
    validateSessionId(sessionId);
    validateRecipeName(recipeName);
  }
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      for (const { sessionId, recipeName, lineCount } of entries) {
        upsertQueuedTransition(db, sessionId, recipeName, lineCount, now);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * 単一エントリの enqueue。`enqueueBatch` と同じ §5.1 遷移ルールを適用する。
 */
export async function enqueue(
  sessionId: string,
  recipeName: string,
  lineCount: number,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      upsertQueuedTransition(db, sessionId, recipeName, lineCount, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * §5.1 遷移ルールに従って単一 (sessionId, recipeName) を queued へ昇格させる。
 * 既存 status / reason / line_count を見て分岐するため、`enqueue` / `enqueueBatch` 両方で共有する。
 */
function upsertQueuedTransition(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  recipeName: string,
  lineCount: number,
  now: number,
): void {
  const sessionPk = getOrCreateSessionPk(db, sessionId);
  const recipePk = getOrCreateRecipePk(db, recipeName);

  const existing = db
    .query(
      `SELECT status, reason, line_count
         FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`,
    )
    .get(sessionPk, recipePk) as {
    status: string;
    reason: string | null;
    line_count: number | null;
  } | null;

  if (!existing) {
    db.run(
      `INSERT INTO queue_entries
         (session_pk, recipe_pk, status, line_count, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [sessionPk, recipePk, lineCount, now, now],
    );
    recordHistory(db, sessionPk, recipePk, "enqueued", null, now);
    return;
  }

  if (!shouldReenqueue(existing, lineCount)) return;

  db.run(
    `UPDATE queue_entries SET status = 'queued', line_count = ?, reason = NULL, updated_at = ?
       WHERE session_pk = ? AND recipe_pk = ?`,
    [lineCount, now, sessionPk, recipePk],
  );
  const fromLabel = existing.reason
    ? `from ${existing.status}:${existing.reason}`
    : `from ${existing.status}`;
  recordHistory(db, sessionPk, recipePk, "reset", fromLabel, now);
}

/**
 * Dequeue the newest queued entry by transitioning it from 'queued' to 'processing'.
 *
 * Design rationale: 以前は SELECT → DELETE していたが、processing 状態を残すことで
 * 同一 (session, recipe) を別プロセス（worker, convert, または並行 worker）が
 * 二重処理しないよう排他制御できる。エントリは処理完了時に
 * markDone/markFailed/markSkipped で遷移する。
 *
 * UPDATE には WHERE status='queued' ガードを入れ、レース時に他プロセスが先行していたら
 * 0行更新となり null を返す（呼び出し側は empty 扱い）。
 *
 * dequeue 順は新しいもの優先（updated_at DESC）。これは ユーザの意向に基づく設計判断:
 * 新規 enqueue 分を先に処理することで、最新のセッションがすぐに処理される利点がある。
 */
export async function dequeue(): Promise<QueueEntry | null> {
  const db = getDb();
  try {
    const now = Date.now();
    let claimed: QueueEntry | null = null;
    const tx = db.transaction(() => {
      const row = db
        .query(
          `SELECT qe.pk, s.uuid AS session_id, r.name AS recipe_name,
                  qe.session_pk, qe.recipe_pk
           FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
           WHERE qe.status = 'queued'
           ORDER BY qe.updated_at DESC
           LIMIT 1`,
        )
        .get() as {
        pk: number;
        session_id: string;
        recipe_name: string;
        session_pk: number;
        recipe_pk: number;
      } | null;

      if (!row) return;

      // Defensive UPDATE with status guard: if another tx already moved it
      // out of 'queued', changes will be 0 and we skip the claim.
      const result = db.run(
        `UPDATE queue_entries SET status = 'processing', updated_at = ?
         WHERE pk = ? AND status = 'queued'`,
        [now, row.pk],
      );
      if (result.changes === 0) return;

      recordHistory(db, row.session_pk, row.recipe_pk, "claimed", "prevStatus: queued", now);

      claimed = {
        sessionId: row.session_id,
        recipeName: row.recipe_name,
        key: formatLogKey(row.session_id, row.recipe_name),
      };
    });
    tx();
    return claimed;
  } finally {
    db.close();
  }
}

export interface ClaimResult {
  /** True if this caller successfully claimed processing ownership. */
  claimed: boolean;
  /** Status before the claim (null if entry did not exist). */
  prevStatus: QueueStatus | null;
}

/**
 * Atomically claim a (session, recipe) pair for processing.
 *
 * - Entry absent → INSERT with status='processing'. Returns claimed=true, prevStatus=null.
 * - Entry queued / done / failed / skipped → UPDATE to status='processing'.
 *   Returns claimed=true, prevStatus=<old>.
 * - Entry already 'processing' → no change. Returns claimed=false, prevStatus='processing'.
 *
 * 重複処理の排他制御を提供する。Convert コマンドは claim に成功した場合に処理を実行し、
 * 失敗した場合は waitForCompletion で他プロセスの完了を待つ。
 *
 * UPDATE には WHERE status=<expected> ガードを入れ、レース時に他プロセスが先に
 * processing 化していたら 0行更新で claim 失敗と扱う。
 */
export async function claim(sessionId: string, recipeName: string): Promise<ClaimResult> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    let result: ClaimResult = { claimed: false, prevStatus: null };
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);

      const row = db
        .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
        .get(sessionPk, recipePk) as { status: QueueStatus } | null;

      if (!row) {
        // Entry absent: INSERT with status='processing'. UNIQUE(session_pk,recipe_pk)
        // guarantees no duplicate. Use INSERT OR IGNORE to be safe against races.
        const ins = db.run(
          `INSERT OR IGNORE INTO queue_entries
             (session_pk, recipe_pk, status, created_at, updated_at)
           VALUES (?, ?, 'processing', ?, ?)`,
          [sessionPk, recipePk, now, now],
        );
        if (ins.changes === 0) {
          // Race: another tx inserted between our SELECT and INSERT. Re-fetch.
          const r2 = db
            .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
            .get(sessionPk, recipePk) as { status: QueueStatus } | null;
          result = { claimed: false, prevStatus: r2?.status ?? null };
          return;
        }
        recordHistory(db, sessionPk, recipePk, "claimed", "prevStatus: absent", now);
        result = { claimed: true, prevStatus: null };
        return;
      }

      if (row.status === "processing") {
        result = { claimed: false, prevStatus: "processing" };
        return;
      }

      // Defensive UPDATE: only succeed if status is still what we observed.
      const upd = db.run(
        `UPDATE queue_entries SET status = 'processing', updated_at = ?
         WHERE session_pk = ? AND recipe_pk = ? AND status = ?`,
        [now, sessionPk, recipePk, row.status],
      );
      if (upd.changes === 0) {
        // Race: status changed between SELECT and UPDATE. Treat as claim failure.
        const r2 = db
          .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
          .get(sessionPk, recipePk) as { status: QueueStatus } | null;
        result = { claimed: false, prevStatus: r2?.status ?? null };
        return;
      }
      recordHistory(db, sessionPk, recipePk, "claimed", `prevStatus: ${row.status}`, now);
      result = { claimed: true, prevStatus: row.status };
    });
    tx();
    return result;
  } finally {
    db.close();
  }
}

/**
 * Record a `dispatch_decided` event in history for (sessionId, "dispatcher").
 * Used by the Phase 2 dispatcher worker to log its JSON output (acceptance
 * list + rejection list + fallback flag) per DR-0008 §6.
 *
 * The queue_entries row itself is updated separately via markDone (after a
 * successful dispatch) so the history event is a strict append-only audit.
 */
export async function recordDispatchDecision(sessionId: string, message: string): Promise<void> {
  validateSessionId(sessionId);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, DISPATCHER_RECIPE_NAME);
      recordHistory(db, sessionPk, recipePk, "dispatch_decided", message, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Mark an entry as done. Idempotent: existing entries are upserted.
 *
 * @param outputFile path to the produced output file (recorded in history.message).
 *                   Pass `null` if no file was produced (e.g. internal mark).
 */
export async function markDone(
  sessionId: string,
  recipeName: string,
  lineCount: number,
  outputFile: string | null,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);
      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, line_count, reason, created_at, updated_at)
         VALUES (?, ?, 'done', ?, NULL, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'done',
           line_count = excluded.line_count,
           reason = NULL,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, lineCount, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "completed", outputFile, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Mark an entry as failed. Increments retry_count.
 * If the entry does not exist, it is created with retry_count=1.
 */
export async function markFailed(
  sessionId: string,
  recipeName: string,
  reason: string | undefined,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);

      const existing = db
        .query(`SELECT retry_count FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
        .get(sessionPk, recipePk) as { retry_count: number } | null;
      const retryCount = (existing?.retry_count ?? 0) + 1;

      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, retry_count, reason, created_at, updated_at)
         VALUES (?, ?, 'failed', ?, ?, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'failed',
           retry_count = excluded.retry_count,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, retryCount, reason ?? null, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "failed", reason ?? null, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Mark an entry as skipped (deliberately not processed; not an error).
 *
 * Design rationale: skipped is a normal terminal state (e.g. empty session,
 * already processed). retry_count is NOT incremented because skipped is not
 * a failure that needs retry-after backoff.
 *
 * `lineCount` is required (DR-0008 §5.1): the enqueue path uses it to
 * decide whether a later session append should auto-recover the entry to
 * queued (only when the new lineCount exceeds the previously recorded one,
 * and only for reasons in REENQUEUABLE_SKIPPED_REASONS).
 *
 * Reason conventions used by callers (extended in DR-0008):
 *   empty_session, no_user_turns, no_conversation,
 *   fork_no_new_conversation, already_processed,
 *   no_effective_turn, dispatcher_rejected, quality_rejected
 */
export async function markSkipped(
  sessionId: string,
  recipeName: string,
  reason: string | undefined,
  lineCount: number,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);
      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, reason, line_count, created_at, updated_at)
         VALUES (?, ?, 'skipped', ?, ?, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'skipped',
           reason = excluded.reason,
           line_count = excluded.line_count,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, reason ?? null, lineCount, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "skipped", reason ?? null, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Reset an entry (failed or skipped) back to queued so it can be retried.
 * Only entries currently in failed/skipped status are moved; any other status is a no-op.
 */
export async function retry(sessionId: string, recipeName: string): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const sessionPk = lookupSessionPk(db, sessionId);
      const recipePk = lookupRecipePk(db, recipeName);
      if (sessionPk === null || recipePk === null) return;
      const result = db.run(
        `UPDATE queue_entries SET status = 'queued', updated_at = ?
         WHERE session_pk = ? AND recipe_pk = ? AND status IN ('failed', 'skipped')`,
        [now, sessionPk, recipePk],
      );
      if (result.changes > 0) {
        recordHistory(db, sessionPk, recipePk, "reset", null, now);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Remove failed entries whose underlying session file no longer exists.
 *
 * Note: skipped/done entries are intentionally NOT cleaned up here — they form
 * the historical record of which sessions have been considered.
 */
export async function cleanup(isSessionExists: (sid: string) => Promise<boolean>): Promise<number> {
  const db = getDb();
  try {
    const rows = db
      .query(
        `SELECT qe.pk, s.uuid AS session_id
         FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
         WHERE qe.status = 'failed'`,
      )
      .all() as { pk: number; session_id: string }[];

    let removed = 0;
    for (const row of rows) {
      const exists = await isSessionExists(row.session_id);
      if (!exists) {
        db.run(`DELETE FROM queue_entries WHERE pk = ?`, [row.pk]);
        removed++;
      }
    }
    return removed;
  } finally {
    db.close();
  }
}
