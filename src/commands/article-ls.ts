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

export function validateSortOrder(value: string | undefined): void {
  if (!value) return;
  if (!SORT_ORDERS.includes(value as SortOrder)) {
    throw new Error(`Invalid sort order: ${value}. Valid values: ${SORT_ORDERS.join(", ")}`);
  }
}

const articleLs = define({
  name: "ls",
  description: "List articles (plain output)",
  args: {
    sort: {
      type: "string",
      description: "Sort order: recipe, date, size",
    },
  },
  run: async (ctx) => {
    validateSortOrder(ctx.values.sort as string | undefined);
    const sort = parseSortOrder(ctx.values.sort as string | undefined, "date");
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
