import { describe, test, expect } from "bun:test";

const CLI = new URL("./index.ts", import.meta.url).pathname;

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("CLI E2E", () => {
  test("引数なしでヘルプを表示", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMANDS");
  });

  test("--help でヘルプを表示", async () => {
    const result = await run("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMANDS");
  });

  test("session 引数なしでサブコマンド一覧を表示", async () => {
    const result = await run("session");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMANDS");
  });

  test("session status でステータスを表示", async () => {
    const result = await run("session", "status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Queued:.*Done:.*Failed:/);
  });

  test("session --help でヘルプを表示", async () => {
    const result = await run("session", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMANDS");
  });

  test("不明なコマンドでエラー", async () => {
    const result = await run("nonexistent-command");
    expect(result.exitCode).not.toBe(0);
  });

  test("extract 引数なしでエラー", async () => {
    const result = await run("extract");
    expect(result.exitCode).not.toBe(0);
  });

  describe("--help shows positional arguments", () => {
    test("extract --help describes the <target> positional", async () => {
      const result = await run("extract", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ARGUMENTS:");
      expect(result.stdout).toContain("target");
      expect(result.stdout).toContain("Session file path or session UUID");
      // USAGE line should include the positional symbol
      expect(result.stdout).toMatch(/extract\s+<OPTIONS>\s+<target>/);
    });

    test("article list --help describes the <pattern> positional", async () => {
      const result = await run("article", "list", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ARGUMENTS:");
      expect(result.stdout).toContain("pattern");
      expect(result.stdout).toContain("recipe name");
      expect(result.stdout).toMatch(/article list\s+<OPTIONS>\s+\[<pattern>\s*\.\.\.\]/);
    });
  });

  describe("--help cross-references between article ls and article list", () => {
    test("article ls --help mentions article list", async () => {
      const result = await run("article", "ls", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("article list");
    });

    test("article list --help mentions article ls", async () => {
      const result = await run("article", "list", "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("article ls");
    });
  });

  describe("article view --sort no longer has -s short form", () => {
    test("article view --help does not advertise -s", async () => {
      const result = await run("article", "view", "--help");
      expect(result.exitCode).toBe(0);
      // sort line should not start with "-s, --sort"
      expect(result.stdout).not.toMatch(/^\s*-s,\s*--sort/m);
      expect(result.stdout).toMatch(/--sort\s+<sort>/);
    });
  });
});
