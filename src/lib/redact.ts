/**
 * Redact common secret patterns from text.
 *
 * Best-effort filter for accidentally pasted credentials in Claude session
 * timelines. Catches well-known token formats so they don't get sent to the
 * Claude API or persisted in the generated article.
 *
 * Design rationale: Personal tooling — favor false positives over misses.
 * Patterns are ordered most-specific-first so that e.g. an Anthropic key
 * (sk-ant-...) is matched as ANTHROPIC_API_KEY before the generic OpenAI
 * sk-... pattern can grab it.
 */

export interface RedactResult {
  text: string;
  count: number;
}

interface Pattern {
  /** Regex with the `g` flag set */
  regex: RegExp;
  /** Replacement string or function. Either form must produce a stable token
   *  that won't be re-matched on subsequent passes. */
  replacement: string | ((match: string, ...groups: string[]) => string);
}

// SSH private key block is multi-line: matched lazily across lines.
const SSH_PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA|PGP) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|OPENSSH|EC|DSA|PGP) )?PRIVATE KEY-----/g;

// JWT: 3 base64url-ish segments separated by dots, starting with "eyJ".
// We require each segment to be reasonably long (>= 8 chars) to avoid
// matching e.g. "eyJ".repeat() noise.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.+/=-]{8,}\b/g;

// AWS access key id: AKIA + 16 uppercase alphanumerics. Word-boundary on both ends.
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

// AWS secret access key: case-insensitive identifier followed by = or : and a value.
const AWS_SECRET_KEY = /aws_secret_access_key\s*[=:]\s*\S+/gi;

// Anthropic API key: sk-ant- prefix + long body of url-safe chars.
// Placed before the generic sk- pattern so this wins.
const ANTHROPIC_API_KEY = /\bsk-ant-[A-Za-z0-9_-]{50,}\b/g;

// OpenAI new key formats (sk-proj-, sk-svcacct-) — these include hyphens and
// underscores in the body, so they need to match before the strict OpenAI sk-
// pattern below (which rejects non-alphanumerics).
const OPENAI_API_KEY_NEW = /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/g;

// OpenAI-style key: sk- prefix + long body. Stricter than Anthropic by char set.
const OPENAI_API_KEY = /\bsk-[A-Za-z0-9]{20,}\b/g;

// GitHub classic tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36 url-safe chars.
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g;

// GitHub fine-grained Personal Access Token: github_pat_ + 22 + _ + 59 chars.
const GITHUB_PAT_FG = /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g;

// Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- + body separated by dashes.
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g;

// Stripe keys: sk_live_ / pk_live_ / rk_live_ + body (test variants too).
const STRIPE_KEY = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g;

// Generic env-style assignment of well-known credential variable names.
// Captures the variable name in group 1 so the replacement keeps it readable.
const GENERIC_API_KEY_ENV =
  /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|HF_TOKEN|SLACK_TOKEN|SLACK_BOT_TOKEN|STRIPE_SECRET_KEY|STRIPE_API_KEY)\s*[=:]\s*\S+/g;

// Loose generic env assignment: catches `<ALL_CAPS>_(KEY|SECRET|PASSWORD|TOKEN)=`
// patterns we haven't enumerated above. Intentionally aggressive (false
// positives are tolerable in a personal tool — leaking a real secret is not).
//
// Negative lookahead `(?!\[REDACTED)` ensures we don't double-count when an
// earlier specific pattern (e.g. GENERIC_API_KEY_ENV) already normalized the
// value to `[REDACTED]`.
const LOOSE_CREDENTIAL_ENV =
  /\b([A-Z][A-Z0-9_]{2,}_(?:API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_KEY|PASSWORD|TOKEN|SECRET))\s*[=:]\s*(?!\[REDACTED)\S+/g;

const PATTERNS: Pattern[] = [
  // Multi-line / structural patterns first
  { regex: SSH_PRIVATE_KEY_BLOCK, replacement: "[REDACTED:SSH_PRIVATE_KEY]" },
  { regex: JWT_PATTERN, replacement: "[REDACTED:JWT]" },

  // Provider-specific tokens (most specific first)
  { regex: ANTHROPIC_API_KEY, replacement: "[REDACTED:ANTHROPIC_API_KEY]" },
  { regex: OPENAI_API_KEY_NEW, replacement: "[REDACTED:OPENAI_API_KEY]" },
  { regex: GITHUB_PAT_FG, replacement: "[REDACTED:GITHUB_PAT]" },
  { regex: GITHUB_TOKEN, replacement: "[REDACTED:GITHUB_TOKEN]" },
  { regex: SLACK_TOKEN, replacement: "[REDACTED:SLACK_TOKEN]" },
  { regex: STRIPE_KEY, replacement: "[REDACTED:STRIPE_KEY]" },
  { regex: AWS_ACCESS_KEY, replacement: "[REDACTED:AWS_ACCESS_KEY]" },

  // Structured assignments — these normalize to NAME=[REDACTED]
  {
    regex: AWS_SECRET_KEY,
    replacement: "aws_secret_access_key=[REDACTED]",
  },
  {
    regex: GENERIC_API_KEY_ENV,
    replacement: (_match, name) => `${name}=[REDACTED]`,
  },

  // Generic OpenAI-style key (broader sk- match, after specific variants)
  { regex: OPENAI_API_KEY, replacement: "[REDACTED:OPENAI_API_KEY]" },

  // Loose generic credential env assignment — catches `<ALL_CAPS>_(API_KEY|
  // SECRET|TOKEN|PASSWORD|...)=` patterns not enumerated above. Placed last
  // so specific patterns win.
  {
    regex: LOOSE_CREDENTIAL_ENV,
    replacement: (_match, name) => `${name}=[REDACTED]`,
  },
];

/**
 * Existing placeholder pattern. We stash these out before scanning so a
 * later pattern can't accidentally re-match the placeholder content
 * (e.g. an existing `[REDACTED:JWT]` shouldn't be touched again).
 *
 * Design rationale: We use a Private Use Area codepoint (U+E000) as a
 * stash sentinel. PUA characters are guaranteed never to be assigned by
 * Unicode and cannot appear in legitimate session timeline text or in
 * any of the credential patterns above, so they're safe as markers.
 * A NUL-byte (\x00) sentinel would be cleaner but trips the
 * `no-control-regex` lint when used inside a regex literal.
 */
const PLACEHOLDER_REGEX = /\[REDACTED(?::[A-Z_]+)?\]/g;
const SENTINEL_MARK = "";
const SENTINEL_RESTORE_REGEX = new RegExp(
  `${SENTINEL_MARK}REDACT_STASH_(\\d+)${SENTINEL_MARK}`,
  "g",
);

export function redactSecrets(text: string): RedactResult {
  if (!text) return { text, count: 0 };

  // 1. Stash existing placeholders so they don't get re-matched.
  const stash: string[] = [];
  const sentinel = (i: number) => `${SENTINEL_MARK}REDACT_STASH_${i}${SENTINEL_MARK}`;
  let scratch = text.replace(PLACEHOLDER_REGEX, (m) => {
    stash.push(m);
    return sentinel(stash.length - 1);
  });

  // 2. Apply each pattern in order, counting hits.
  let count = 0;
  for (const { regex, replacement } of PATTERNS) {
    if (typeof replacement === "string") {
      scratch = scratch.replace(regex, () => {
        count++;
        return replacement;
      });
    } else {
      scratch = scratch.replace(regex, (...args) => {
        count++;
        // args = [match, ...groups, offset, full string, (groups obj)]
        // Pull match + groups; replacement function only needs (match, ...groups)
        const match = args[0] as string;
        const groups: string[] = [];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (typeof a === "string") {
            groups.push(a);
          } else {
            break; // hit the offset (number)
          }
        }
        return replacement(match, ...groups);
      });
    }
  }

  // 3. Restore stashed placeholders.
  scratch = scratch.replace(SENTINEL_RESTORE_REGEX, (_m, idx) => stash[Number(idx)] ?? _m);

  return { text: scratch, count };
}
