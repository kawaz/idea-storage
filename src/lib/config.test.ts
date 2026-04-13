import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.ts";

describe("config", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "config-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(async () => {
    process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    test("returns default values when config.ts does not exist", async () => {
      const config = await loadConfig();
      expect(config.claudeDirs).toEqual([`${process.env.HOME}/.claude`]);
      expect(config.minAgeMinutes).toBe(120);
    });

    test("merges partial config with defaults", async () => {
      const configDir = join(tempDir, "idea-storage");
      await Bun.write(join(configDir, "config.ts"), `export default { minAgeMinutes: 60 }\n`);
      const config = await loadConfig();
      expect(config.minAgeMinutes).toBe(60);
      // Defaults should remain
      expect(config.claudeDirs).toEqual([`${process.env.HOME}/.claude`]);
    });

    test("overrides all fields when config.ts provides them", async () => {
      const configDir = join(tempDir, "idea-storage");
      await Bun.write(
        join(configDir, "config.ts"),
        `export default {
  claudeDirs: ["/home/user/.claude", "/home/user/.claude-work"],
  minAgeMinutes: 30,
}\n`,
      );
      const config = await loadConfig();
      expect(config.claudeDirs).toEqual(["/home/user/.claude", "/home/user/.claude-work"]);
      expect(config.minAgeMinutes).toBe(30);
    });

    test("handles config.ts with only claudeDirs", async () => {
      const configDir = join(tempDir, "idea-storage");
      await Bun.write(
        join(configDir, "config.ts"),
        `export default { claudeDirs: ["/custom/.claude"] }\n`,
      );
      const config = await loadConfig();
      expect(config.claudeDirs).toEqual(["/custom/.claude"]);
      expect(config.minAgeMinutes).toBe(120);
    });
  });
});
