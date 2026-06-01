import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactForOutput } from "../redact-pipeline.ts";

/**
 * DR-0009 Phase 1 防御層: LLM 出力を永続化する最後の砦。
 *
 * - 出力直前に redactForOutput を通す (= timeline は入力で redact 済だが、
 *   LLM が transcribe / hallucinate した secret を最終出力から落とす)
 * - 新規 dir は mode 0700 で作成 (既存 dir はそのまま、Phase 1 方針)
 * - file は mode 0600 (owner-only)
 *
 * 受入経路 (accepted output) と退避経路 (_rejected/) で挙動は同一なので
 * 1 関数に集約。呼び出し側は出力 path を構築するだけで良い。
 *
 * redactForOutput は idempotent なので、フロントマター内の値 (= 既に
 * generateFrontmatter で redact 済) も二重 redact 影響なし。
 */
async function persist(outputFile: string, fullOutput: string): Promise<void> {
  // 出力 dir を mode 0700 で確保 (既存 dir は no-op)。dir 階層中の
  // 既存パーミッションは retroactive に変更しない (DR-0009 Phase 1 方針)。
  await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
  // Final defense layer before any persistence path: even though the
  // timeline was redacted on input, the LLM can re-emit secrets it observed.
  // frontmatter values are already redacted by generateFrontmatter; this
  // pass is idempotent for them and primarily protects the body.
  const safeOutput = redactForOutput(fullOutput);
  await Bun.write(outputFile, safeOutput);
  await chmod(outputFile, 0o600);
}

/** 受入経路: quality_gate を通過した accepted output を出力 path に書き出す。 */
export async function persistAccepted(outputFile: string, fullOutput: string): Promise<void> {
  await persist(outputFile, fullOutput);
}

/**
 * 退避経路: quality_gate に reject された LLM 生出力を _rejected/ に書き出す。
 * 機密性は accepted と同等 (LLM 生出力なので、redact + 0600 が必須)。
 */
export async function persistRejected(rejectedFile: string, fullOutput: string): Promise<void> {
  await persist(rejectedFile, fullOutput);
}
