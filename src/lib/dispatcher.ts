/**
 * DR-0008 §6: dispatcher (Phase 2)
 *
 * 1 セッションに対して LLM に「明らかに不適合な recipe を除外する」判断を
 * 仰ぐ。入力はセッションメタ + `Recipe.hint` のみ (タイムライン本文は渡さない)。
 * 出力は JSON で採用 recipe のリスト。
 *
 * 異常系:
 * - API timeout / 接続エラー: caller が markFailed → 既存 retry 機構に委譲
 * - JSON parse 失敗 / 構造的崩れ: 全 recipe を採用する fallback を返す
 *   (= dispatcher_fallback。dispatcher 自身は markDone)
 * - 出力に含まれる存在しない recipe 名: 警告ログのみで無視
 * - `"recipes": []`: 「書かない判断」として尊重、全 recipe を rejected に
 */

import type { Recipe, SessionMeta } from "../types/index.ts";
import { type ClaudeRunner, runClaude } from "./claude-runner.ts";
import { getDispatcherPromptPath } from "./paths.ts";
import { redactForOutput, redactForPrompt } from "./redact-pipeline.ts";

export interface DispatcherInput {
  sessionId: string;
  meta: SessionMeta;
  /** matchesRecipe を通過した user recipes (静的 match での絞り込み済み)。 */
  recipes: Recipe[];
  /**
   * Prompt template. Defaults to `loadDispatcherPrompt()` (configDir → default).
   * Tests can inject a fixed template here.
   */
  promptTemplate?: string;
  /**
   * Override runClaude (for tests). Uses the unified `ClaudeRunner` signature
   * (DR-0009 Phase 3 step 3-e): receives full options, returns the response text.
   */
  _runClaude?: ClaudeRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DispatcherDecision {
  /** Names of recipes the dispatcher accepted (= should be enqueued). */
  acceptedRecipes: string[];
  /** Names of recipes that should be markSkipped(dispatcher_rejected). */
  rejectedRecipes: string[];
  /**
   * JSON string to persist via history(dispatch_decided). Contains the raw
   * LLM output (truncated if huge), the final accepted/rejected lists, and
   * any fallback marker.
   */
  decisionMessage: string;
  /**
   * Non-null when the LLM output was structurally bad (could not be parsed)
   * and we fell back to "accept all". `reason` is a short tag for telemetry
   * (e.g. `json_parse_error`).
   */
  fallback: { reason: string } | null;
}

/**
 * Default dispatcher prompt embedded in the binary. Used when
 * `$XDG_CONFIG_HOME/idea-storage/dispatcher_prompt.md` is absent. Keep this
 * minimal — power users are expected to copy and customize the example
 * under `config-examples/dispatcher_prompt.md`.
 */
const DEFAULT_DISPATCHER_PROMPT = `あなたは "recipe dispatcher" です。1 セッションと利用可能な recipe を渡されます。
明らかに不適合な recipe を除外してください。迷ったら採用 (recall を優先)。
判断材料はセッションのメタ情報と各 recipe の hint 行のみです。タイムライン本文は渡されません。
hint がない recipe は「判断不能」として基本的に採用してください。

出力は次の JSON のみ。前後の説明文・コードフェンス禁止:

{"recipes":[{"name":"<recipe_name>","reason":"<短い採用理由>"}]}

- recipes は採用する recipe のリスト
- recipe 名はリストに与えられたものだけ使う (新規創作禁止)
- 「書かない判断」は {"recipes":[]} で表現可`;

/** Load the dispatcher prompt template from configDir, falling back to the default. */
export async function loadDispatcherPrompt(): Promise<string> {
  const path = getDispatcherPromptPath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return DEFAULT_DISPATCHER_PROMPT;
    return await file.text();
  } catch {
    return DEFAULT_DISPATCHER_PROMPT;
  }
}

/** Build the structured input block appended after the prompt template. */
function buildDispatcherInputBlock(input: DispatcherInput): string {
  const { meta, recipes } = input;
  const ageMinutes = Math.floor(meta.ageSec / 60);
  // project / recipe.hint are session/config-derived strings that might carry
  // accidental secrets (e.g. a path containing a token, a hint authored with
  // an env var leak). Redact before sending to the dispatcher LLM.
  const project = redactForPrompt(meta.project || "unknown");
  const recipesList = recipes
    .map((r) => `- ${r.name}: ${redactForPrompt(r.hint ?? "(no hint)")}`)
    .join("\n");
  return [
    "## Session",
    `- id: ${input.sessionId}`,
    `- project: ${project}`,
    `- age_minutes: ${ageMinutes}`,
    `- user_turns: ${meta.userTurns}`,
    `- effective_user_turns: ${meta.effectiveUserTurns}`,
    `- line_count: ${meta.lineCount}`,
    `- forked_from: ${meta.forkInfo?.parentSessionId ?? "null"}`,
    "",
    "## Recipes available",
    recipesList,
  ].join("\n");
}

interface DispatcherJsonOutput {
  recipes: Array<{ name?: unknown; reason?: unknown }>;
}

/**
 * Parse the LLM output to a `{ recipes: [...] }` object.
 * Tries strict JSON.parse first, then falls back to extracting the first
 * `{ ... }` substring (handles trailing chatter or stray code fences).
 * Returns null when parsing fails entirely.
 */
function parseDispatcherOutput(raw: string): DispatcherJsonOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch && objMatch[0] !== trimmed) candidates.push(objMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as DispatcherJsonOutput).recipes)
      ) {
        return parsed as DispatcherJsonOutput;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Run the dispatcher LLM and resolve into an explicit accepted/rejected
 * partition over `input.recipes`.
 *
 * Throws on transient LLM failures (timeout, spawn error, abort). The caller
 * is expected to mark the dispatcher entry failed in that case so DR-0007's
 * retry mechanism takes over. Structural failures (bad JSON) are *not*
 * thrown — they resolve to a fallback decision with all recipes accepted.
 */
export async function runDispatcher(input: DispatcherInput): Promise<DispatcherDecision> {
  const template = input.promptTemplate ?? (await loadDispatcherPrompt());
  const fullPrompt = `${template.trim()}\n\n${buildDispatcherInputBlock(input)}\n`;

  const run = input._runClaude ?? runClaude;
  const raw = await run({
    prompt: fullPrompt,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  const allNames = input.recipes.map((r) => r.name);
  const parsed = parseDispatcherOutput(raw);

  if (!parsed) {
    return {
      acceptedRecipes: [...allNames],
      rejectedRecipes: [],
      decisionMessage: JSON.stringify({
        fallback: "json_parse_error",
        // raw_excerpt is persisted into history via recordDispatchDecision —
        // redact before the slice lands on disk.
        raw_excerpt: redactForOutput(raw.slice(0, 500)),
      }),
      fallback: { reason: "json_parse_error" },
    };
  }

  const knownSet = new Set(allNames);
  const requestedNames: string[] = [];
  const unknownNames: string[] = [];
  for (const r of parsed.recipes) {
    const n = typeof r.name === "string" ? r.name.trim() : "";
    if (!n) continue;
    if (knownSet.has(n)) {
      if (!requestedNames.includes(n)) requestedNames.push(n);
    } else {
      unknownNames.push(n);
    }
  }
  const requestedSet = new Set(requestedNames);
  const rejectedRecipes = allNames.filter((n) => !requestedSet.has(n));

  return {
    acceptedRecipes: requestedNames,
    rejectedRecipes,
    decisionMessage: JSON.stringify({
      accepted: requestedNames,
      rejected: rejectedRecipes,
      ...(unknownNames.length > 0 ? { unknown: unknownNames } : {}),
      reasons: parsed.recipes
        .filter((r) => typeof r.name === "string" && typeof r.reason === "string")
        .map((r) => ({ name: r.name as string, reason: r.reason as string })),
    }),
    fallback: null,
  };
}
