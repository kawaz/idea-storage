import { join } from "node:path";

/** UUID pattern without file extension (for matching bare UUIDs) */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID pattern with .jsonl extension (for matching session filenames) */
export const UUID_JSONL_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Search for a session file by UUID across multiple Claude directories.
 * Returns the full path to the first matching .jsonl file, or null if not found.
 */
export async function findSessionFile(
  claudeDirs: string[],
  sessionId: string,
): Promise<string | null> {
  for (const claudeDir of claudeDirs) {
    const projectsDir = join(claudeDir, "projects");
    const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
    for await (const relativePath of glob.scan(projectsDir)) {
      return join(projectsDir, relativePath);
    }
  }
  return null;
}
