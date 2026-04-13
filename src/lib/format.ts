export function formatSmartSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const v = bytes / (1024 * 1024 * 1024);
    return v >= 10 ? `${Math.round(v)}G` : `${v.toFixed(1)}G`;
  }
  if (bytes >= 1024 * 1024) {
    const v = bytes / (1024 * 1024);
    return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`;
  }
  const v = bytes / 1024;
  if (v < 0.1) return "0.1K";
  return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`;
}

export function formatAge(ageSec: number): string {
  if (ageSec >= 86400) return `${Math.floor(ageSec / 86400)}d`;
  if (ageSec >= 3600) return `${Math.floor(ageSec / 3600)}h`;
  if (ageSec >= 60) return `${Math.floor(ageSec / 60)}m`;
  return `${ageSec}s`;
}

export function toJSTISOString(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  const s = String(jst.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

export function formatDuration(startMs: number, endMs: number): string {
  const sec = Math.floor((endMs - startMs) / 1000);
  if (sec < 0) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `0m${String(s).padStart(2, "0")}s`;
}

export function formatTimestamp(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}/${mo}/${d}T${h}:${mi}`;
}

/** Format a date as YYYY/MM/DD path */
export function formatDatePath(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/** Format a date as UTC compact timestamp: yyyymmddTHHMMSSZ */
export function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export type SortOrder = "recipe" | "date" | "size";
export const SORT_ORDERS: SortOrder[] = ["recipe", "date", "size"];

/** Parse a sort order string, returning a default if invalid */
export function parseSortOrder(
  value: string | undefined,
  defaultOrder: SortOrder = "recipe",
): SortOrder {
  if (value && SORT_ORDERS.includes(value as SortOrder)) return value as SortOrder;
  return defaultOrder;
}
