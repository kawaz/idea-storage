import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listRecentOutputs, formatInjectedRecent } from "./recent-outputs.ts";

describe("listRecentOutputs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "recent-outputs-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function place(rel: string, body: string): Promise<void> {
    const full = join(tmp, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }

  test("recipeDir 不在なら空配列を返す", async () => {
    const out = await listRecentOutputs(tmp, "diary", 5);
    expect(out).toEqual([]);
  });

  test("n=0 なら何も読まない", async () => {
    await place("diary/2026/05/30/20260530T100000Z.aaa.md", "body");
    const out = await listRecentOutputs(tmp, "diary", 0);
    expect(out).toEqual([]);
  });

  test("ファイル名 timestamp 順で newest first に N 本返す", async () => {
    await place("diary/2026/05/28/20260528T100000Z.s1.md", "old1");
    await place("diary/2026/05/29/20260529T100000Z.s2.md", "old2");
    await place("diary/2026/05/30/20260530T100000Z.s3.md", "newest");

    const out = await listRecentOutputs(tmp, "diary", 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.body).toBe("newest");
    expect(out[1]!.body).toBe("old2");
  });

  test("既存ファイル数 < N でも問題なく読める", async () => {
    await place("diary/2026/05/30/20260530T100000Z.s.md", "only");
    const out = await listRecentOutputs(tmp, "diary", 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("only");
  });

  test("recipe が違うディレクトリは無視される", async () => {
    await place("diary/2026/05/30/20260530T100000Z.s.md", "diary-body");
    await place("knowledge/2026/05/30/20260530T100000Z.s.md", "kn-body");
    const out = await listRecentOutputs(tmp, "diary", 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("diary-body");
  });
});

describe("formatInjectedRecent", () => {
  test("空リストなら空文字列", () => {
    expect(formatInjectedRecent([])).toBe("");
  });

  test("出力が prompt 先頭ブロックに組み込まれる", () => {
    const text = formatInjectedRecent([
      { filePath: "/data/diary/2026/05/30/x.md", body: "本文1" },
      { filePath: "/data/diary/2026/05/29/y.md", body: "本文2" },
    ]);
    expect(text).toContain("過去出力");
    expect(text).toContain("/data/diary/2026/05/30/x.md");
    expect(text).toContain("本文1");
    expect(text).toContain("本文2");
    // 末尾に区切り --- が入って prompt 本体と分離される
    expect(text).toMatch(/---\n+$/);
  });

  test("DR-0009 Phase 1 S2: body に含まれる secret は注入時に redact される", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const text = formatInjectedRecent([
      { filePath: "/data/diary/2026/05/30/x.md", body: `本文 token=${ghToken} 続き` },
    ]);
    expect(text).not.toContain(ghToken);
    expect(text).toContain("[REDACTED:GITHUB_TOKEN]");
  });
});
