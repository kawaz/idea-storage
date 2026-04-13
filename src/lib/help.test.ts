import { describe, expect, test } from "bun:test";
import { showHelp } from "./help.ts";
import type { HelpSection } from "./help.ts";

function createMockCtx(
  usage: string,
  overrides?: { name?: string; commandPath?: string[]; envName?: string },
) {
  const logs: string[] = [];
  return {
    ctx: {
      name: overrides?.name ?? "idea-storage",
      commandPath: overrides?.commandPath ?? [],
      env: {
        name: overrides?.envName ?? "idea-storage",
        renderUsage: async () => usage,
      },
      log: (msg: string) => {
        logs.push(msg);
      },
    },
    logs,
  };
}

describe("showHelp", () => {
  test("removes lines before USAGE:", async () => {
    const usage = `idea-storage - manage ideas\n\nUSAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).toStartWith("USAGE:");
  });

  test("removes self line from COMMANDS section", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nCOMMANDS:\n  [idea-storage] <OPTIONS>  Entry command\n  process                   Process sessions\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).not.toContain("[idea-storage] <OPTIONS>");
    expect(logs[0]).toContain("process");
  });

  test("rewrites USAGE line with full command path", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nCOMMANDS:\n  process  Process sessions\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).toContain("idea-storage COMMANDS");
    expect(logs[0]).not.toContain("[COMMANDS]");
  });

  test("handles subcommand context with commandPath", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nCOMMANDS:\n  [process] <OPTIONS>  Process command\n  run                  Run something\n\nOPTIONS:\n  --verbose  Verbose output`;
    const { ctx, logs } = createMockCtx(usage, { name: "process", commandPath: ["process"] });

    await showHelp(ctx);

    expect(logs[0]).toContain("idea-storage process COMMANDS");
    expect(logs[0]).not.toContain("[process] <OPTIONS>");
  });

  test("renames OPTIONS to GLOBAL OPTIONS", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).toContain("GLOBAL OPTIONS:");
    expect(logs[0]).not.toMatch(/^OPTIONS:/m);
  });

  test("inserts additional sections before GLOBAL OPTIONS", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    const sections: HelpSection[] = [
      { title: "ENVIRONMENTS", lines: ["IDEA_STORAGE_DIR  Storage directory"] },
    ];

    await showHelp(ctx, { sections });

    const output = logs[0]!;
    const envPos = output.indexOf("ENVIRONMENTS:");
    const globalPos = output.indexOf("GLOBAL OPTIONS:");
    expect(envPos).toBeGreaterThan(-1);
    expect(globalPos).toBeGreaterThan(-1);
    expect(envPos).toBeLessThan(globalPos);
    expect(output).toContain("  IDEA_STORAGE_DIR  Storage directory");
  });

  test("inserts multiple sections in order", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    const sections: HelpSection[] = [
      { title: "ENVIRONMENTS", lines: ["ENV_VAR  description"] },
      { title: "FILES", lines: ["~/.config/idea-storage/  Config dir"] },
    ];

    await showHelp(ctx, { sections });

    const output = logs[0]!;
    const envPos = output.indexOf("ENVIRONMENTS:");
    const filesPos = output.indexOf("FILES:");
    const globalPos = output.indexOf("GLOBAL OPTIONS:");
    expect(envPos).toBeLessThan(filesPos);
    expect(filesPos).toBeLessThan(globalPos);
  });

  test('removes "For more info" section', async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\nFor more info, run any command with the \`--help\` flag:\n  idea-storage process --help\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).not.toContain("For more info");
  });

  test("collapses multiple consecutive blank lines", async () => {
    const usage = `USAGE:\n  idea-storage [COMMANDS] <OPTIONS>\n\n\n\n\nOPTIONS:\n  --help  Show help`;
    const { ctx, logs } = createMockCtx(usage);

    await showHelp(ctx);

    expect(logs[0]).not.toMatch(/\n{3,}/);
  });
});
