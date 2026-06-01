import { generateFrontmatter } from "../frontmatter.ts";
import type { SessionMeta } from "../../types/index.ts";

/**
 * Build a serialized YAML frontmatter block for a processed session output.
 *
 * Inputs are aggregated into the canonical fmData shape and forwarded to
 * generateFrontmatter (which handles per-value redaction / quoting). Returns
 * the full `---\n...\n---\n` text ready to be prepended to the body.
 */
export function buildFrontmatter(args: {
  sessionId: string;
  meta: SessionMeta;
  sessionStats: { turns?: number; bytes?: number; duration_ms?: number };
  recipeName: string;
  claudeMeta: { model: string | null; version: string | null };
  sessionStart: string;
  sessionEnd: string;
  generatedAt: string;
}): string {
  const { sessionId, meta, sessionStats, recipeName, claudeMeta } = args;
  const fmData: Record<string, unknown> = {
    session_id: sessionId,
    project: meta.project || "unknown",
    session_start: args.sessionStart,
    session_end: args.sessionEnd,
    generated_at: args.generatedAt,
    recipe: recipeName,
    user_turns: sessionStats.turns ?? meta.userTurns,
    session_bytes: sessionStats.bytes,
    duration_ms: sessionStats.duration_ms,
    // DR-0008 §10: track which model/version produced this output so future
    // analyses (Phase 4 quality_guidelines auto-update) can segment by model.
    claude_model: claudeMeta.model,
    claude_version: claudeMeta.version,
  };
  if (meta.forkInfo) {
    fmData.forked_from = meta.forkInfo.parentSessionId;
  }
  return generateFrontmatter(fmData);
}
