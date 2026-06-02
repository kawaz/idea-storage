/**
 * DR-0008 §10: 出力 frontmatter に `claude_model` / `claude_version` を埋め込む
 * ためのメタ取得 + プロセス内キャッシュ。
 *
 * - `claude_version`: `claude --version` 出力を 1 度だけ実行してキャッシュ
 * - `claude_model`: `process.env.ANTHROPIC_MODEL` / `CLAUDE_MODEL` を観察
 *   (CLI 自体が動的に model を返す API は現状ないため env を信頼する)
 *
 * 取得失敗は静かに null。frontmatter には null/欠落で記録される。
 */

interface ClaudeMeta {
  model: string | null;
  version: string | null;
}

let cached: ClaudeMeta | null = null;

export async function getClaudeMeta(): Promise<ClaudeMeta> {
  if (cached) return cached;

  let version: string | null = null;
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode === 0) {
      version = out.trim() || null;
    }
  } catch {
    // best-effort: leave version null
  }

  const model = process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_MODEL ?? null;

  cached = { model, version };
  return cached;
}

/** Test helper: invalidate the cached meta so the next call re-spawns claude. */
export function _resetClaudeMetaCacheForTest(): void {
  cached = null;
}
