import { define } from "gunshi";
import { getDataDir } from "../lib/paths.ts";
import {
  formatSmartSize,
  toJSTISOString,
  parseSortOrder,
  type SortOrder,
  SORT_ORDERS,
} from "../lib/format.ts";
import { listViewEntries, sortEntries } from "./article-view.ts";

/**
 * Sort key aliases shared with `article list` / `article view`.
 *
 * Design rationale: `article ls` uses file-based concepts (recipe, date, size)
 * while `article list` uses session-based concepts (rule, start, ...). The
 * concepts overlap (recipe == rule, date == start), so we accept both spellings
 * to reduce cognitive load between the commands.
 */
const SORT_ALIASES: Record<string, SortOrder> = {
  recipe: "recipe",
  rule: "recipe",
  date: "date",
  start: "date",
  size: "size",
};

const VALID_SORT_INPUTS = Object.keys(SORT_ALIASES);

export function validateSortOrder(value: string | undefined): void {
  if (!value) return;
  if (!(value in SORT_ALIASES) && !SORT_ORDERS.includes(value as SortOrder)) {
    throw new Error(`Invalid sort order: ${value}. Valid values: ${VALID_SORT_INPUTS.join(", ")}`);
  }
}

export function resolveSortOrder(value: string | undefined, defaultOrder: SortOrder): SortOrder {
  if (value && value in SORT_ALIASES) return SORT_ALIASES[value]!;
  return parseSortOrder(value, defaultOrder);
}

const articleLs = define({
  name: "ls",
  description: "List articles (plain output, see also: `article list` for rich formatting)",
  args: {
    sort: {
      type: "string",
      description: "Sort order: recipe (alias: rule), date (alias: start), size",
    },
  },
  run: async (ctx) => {
    validateSortOrder(ctx.values.sort as string | undefined);
    const sort = resolveSortOrder(ctx.values.sort as string | undefined, "date");
    const dataDir = getDataDir();
    const entries = await listViewEntries(dataDir);
    if (entries.length === 0) {
      console.log("No articles found.");
      return;
    }
    const sorted = sortEntries(entries, sort);
    // date ソートは昇順なので reverse して最新が上に
    const reversed = sort === "date" ? [...sorted].reverse() : sorted;

    const sizes = reversed.map((e) => formatSmartSize(e.sizeBytes));
    const maxSizeLen = Math.max(...sizes.map((s) => s.length));

    for (let i = 0; i < reversed.length; i++) {
      const ts = toJSTISOString(reversed[i]!.mtime);
      const size = sizes[i]!.padStart(maxSizeLen);
      console.log(`${ts}  ${size}  ${reversed[i]!.fullPath}`);
    }
  },
});

export default articleLs;
