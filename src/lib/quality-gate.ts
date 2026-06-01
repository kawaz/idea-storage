/**
 * DR-0008 §8: 品質ガード (Phase 3)
 *
 * processSession の最後に出力 (生成済み markdown 本文) を LLM に渡し、
 * 「読む価値があるか」を二値で判定。不採用の場合は `_rejected/` に退避して
 * queue_entries は `skipped(quality_rejected, lineCount=N)` で記録する
 * (caller の責務)。
 *
 * 設計判断:
 * - LLM 失敗 (transient): caller に throw して既存 retry 経路に乗せたいところだが、
 *   品質ガードは「補助的なフィルタ」で main path の成功を妨げるべきでない。
 *   そこで本モジュールは LLM 失敗時に `kind: "accepted"` の保守的判断 (= 退避しない)
 *   を返す。判定が unstable な側で間違えるより、出力を残す側で間違えるほうが安い。
 * - JSON 解析失敗も同上 (accept fallback)。
 * - 採否表現は二値 (accepted/rejected) + reason テキスト (DR-0008 §8、スコアは校正不安定)
 */

import { runClaude } from "./claude-runner.ts";
import { getQualityGuidelinesPath } from "./paths.ts";
import { redactForPrompt } from "./redact-pipeline.ts";

export interface QualityGateInput {
  /** Generated output (markdown body, without frontmatter). */
  output: string;
  /** Recipe name producing this output (for log context). */
  recipeName: string;
  /** Guidelines text. Defaults to loadQualityGuidelines() (stateDir → default). */
  guidelines?: string;
  /** Override runClaude (for tests). */
  _runClaude?: (prompt: string) => Promise<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface QualityVerdict {
  /**
   * "accepted" — keep output and write to normal dataDir.
   * "rejected" — divert to _rejected/. caller marks the queue entry as
   *   skipped(quality_rejected).
   */
  kind: "accepted" | "rejected";
  /** Short tag/explanation for telemetry + audit. Always present. */
  reason: string;
  /**
   * Non-null when the LLM verdict could not be obtained (network/timeout/parse fail)
   * and we fell back to "accepted". Caller logs this for visibility.
   */
  fallback: { reason: string } | null;
}

/** Embedded default guidelines used when stateDir file is absent. */
const DEFAULT_GUIDELINES = `## 採用基準
- 読む価値がある (新しい気づき・固有の情報)
- セッションの実体を反映している
- 簡潔で読みやすい

## 不採用の典型
- テンプレ表現の連発、過剰総括、過剰持ち上げ
- 空セッションへの無理な作文
- タイムラインの単純な並列要約 (解釈ゼロ)`;

const VERDICT_PROMPT_HEADER = `あなたは出力品質の最終ガードです。
以下のガイドラインに従って、与えられた成果物を採用か不採用か判定してください。
判定は「読む価値があるか」「内容が薄くないか」で判断します。

出力は次の JSON のみ。前後の説明文・コードフェンス禁止:

{"kind":"accepted","reason":"<短い理由>"}
または
{"kind":"rejected","reason":"<短い理由>"}`;

/** Load quality guidelines from stateDir, falling back to the embedded default. */
export async function loadQualityGuidelines(): Promise<string> {
  const path = getQualityGuidelinesPath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return DEFAULT_GUIDELINES;
    return await file.text();
  } catch {
    return DEFAULT_GUIDELINES;
  }
}

interface VerdictJson {
  kind?: unknown;
  reason?: unknown;
}

function parseVerdictOutput(raw: string): VerdictJson | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m && m[0] !== trimmed) candidates.push(m[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as VerdictJson;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Run the quality gate. Always resolves (never throws): structural and
 * transient failures both fall back to `accepted` so the main output path
 * is not blocked by the gate's reliability.
 */
export async function runQualityGate(input: QualityGateInput): Promise<QualityVerdict> {
  const guidelines = input.guidelines ?? (await loadQualityGuidelines());
  // Defense in depth: even though processSession redacts the timeline before
  // generation, the LLM output itself can re-introduce secrets (verbatim
  // transcription, hallucinated keys). Strip before re-sending to the gate LLM.
  const prompt = [
    VERDICT_PROMPT_HEADER,
    "",
    "## Guidelines",
    guidelines.trim(),
    "",
    `## Output (recipe=${input.recipeName})`,
    redactForPrompt(input.output),
  ].join("\n");

  let raw: string;
  try {
    raw = input._runClaude
      ? await input._runClaude(prompt)
      : await runClaude({
          prompt,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "accepted",
      reason: "quality_gate_unreachable",
      fallback: { reason: `claude_error:${reason.slice(0, 200)}` },
    };
  }

  const parsed = parseVerdictOutput(raw);
  if (!parsed) {
    return {
      kind: "accepted",
      reason: "quality_gate_parse_fail",
      fallback: { reason: "json_parse_error" },
    };
  }

  const kindRaw = typeof parsed.kind === "string" ? parsed.kind : "";
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : "(no reason)";
  if (kindRaw === "rejected") {
    return { kind: "rejected", reason, fallback: null };
  }
  // Default to accepted for any non-"rejected" value (defensive: the gate
  // should never block on ambiguity).
  return { kind: "accepted", reason, fallback: null };
}
