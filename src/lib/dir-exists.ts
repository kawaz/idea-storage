import { stat } from "node:fs/promises";

/**
 * Check if a path exists and is a directory.
 * Uses stat() instead of Bun.file().exists() which has undefined behavior on directories.
 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
