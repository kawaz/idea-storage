/**
 * Build a minimal env for subprocesses that do NOT need access to API
 * credentials.
 *
 * Design rationale: `claude-session-analysis` (CSA) only reads local session
 * JSONL files; it does not call any API. Passing `{ ...process.env }` would
 * give a compromised or PATH-shadowed CSA access to every secret in the env
 * (ANTHROPIC_API_KEY, GH_TOKEN, SSH_AUTH_SOCK, 1Password socket, AWS creds,
 * ...) — and redact pipeline cannot reach into child process env. The fix is
 * to allowlist the env keys CSA actually needs.
 *
 * Note: `claude` CLI spawn (claude-runner.ts) deliberately gets the full env
 * because it talks to the Anthropic API and needs ANTHROPIC_API_KEY. Only
 * CSA-class subprocesses go through this helper.
 */

const CSA_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Discovery / FS layout
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  // Binary lookup
  "PATH",
  // XDG dirs (CSA may resolve config / data via XDG)
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // i18n / time
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  // Test isolation: idea-storage tests override these to point CSA at a
  // tempDir-rooted .claude/ for fixture session discovery.
  "CLAUDE_CONFIG_DIR",
]);

/**
 * Return a process env containing only keys CSA needs. Drops everything else
 * (secrets, agent sockets, GitHub tokens, ...).
 */
export function buildCsaEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CSA_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) result[key] = v;
  }
  return result;
}
