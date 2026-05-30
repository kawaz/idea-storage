/**
 * DR-0008 §9: 過去出力注入。
 *
 * 指定 recipe について、`{dataDir}/{recipe}/YYYY/MM/DD/*.md` を再帰的に走査し、
 * ファイル名 timestamp 順で直近 N 本を返す。
 *
 * 設計判断:
 * - DB index ではなく filesystem 直接走査 (DR-0008 §9 の理由: filesystem との
 *   同期問題回避)
 * - 出力ファイル名は `<yyyymmddTHHMMSSZ>.<sessionId>.md` 形式なので、
 *   全パスを sort すれば自然に時刻順になる
 * - 本数固定 (バイトや期間ベースは校正が複雑、本実装範囲外)
 */

import { join } from "node:path";

interface RecentOutput {
  filePath: string;
  body: string;
}

/**
 * Return the most recent N output files for the given recipe.
 * Newest first. Returns fewer than N if not enough files exist.
 */
export async function listRecentOutputs(
  dataDir: string,
  recipeName: string,
  n: number,
): Promise<RecentOutput[]> {
  if (n <= 0) return [];
  const recipeDir = join(dataDir, recipeName);
  const glob = new Bun.Glob("**/*.md");

  const paths: string[] = [];
  try {
    for await (const rel of glob.scan(recipeDir)) {
      paths.push(rel);
    }
  } catch {
    // recipeDir does not exist yet → no recent outputs
    return [];
  }
  if (paths.length === 0) return [];

  // Filename starts with yyyymmddTHHMMSSZ — sort lexicographically, then take
  // the last N (= newest).
  paths.sort();
  const latest = paths.slice(-n).reverse(); // newest first

  const result: RecentOutput[] = [];
  for (const rel of latest) {
    const full = join(recipeDir, rel);
    try {
      const body = await Bun.file(full).text();
      result.push({ filePath: full, body });
    } catch {
      // file disappeared between scan and read — skip
    }
  }
  return result;
}

/**
 * Format recent outputs into a markdown block to prepend to a recipe prompt.
 * Empty string when list is empty.
 */
export function formatInjectedRecent(outputs: RecentOutput[]): string {
  if (outputs.length === 0) return "";
  const lines: string[] = [
    "## 直近の過去出力 (参考、繰り返し回避用)",
    "",
    "以下は同じ recipe の直近の出力です。同じ表現の繰り返しを避け、観点を変える材料に。",
    "",
  ];
  for (const o of outputs) {
    lines.push(`### ${o.filePath}`);
    lines.push("");
    lines.push(o.body);
    lines.push("");
  }
  return `${lines.join("\n")}\n---\n\n`;
}
