import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCsaEnv } from "./spawn-env.ts";

describe("buildCsaEnv", () => {
  const saved: Record<string, string | undefined> = {};

  function snapshot(keys: string[]): void {
    for (const k of keys) saved[k] = process.env[k];
  }
  function restore(): void {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  beforeEach(() => {
    snapshot([
      "HOME",
      "PATH",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SSH_AUTH_SOCK",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "LANG",
    ]);
  });

  afterEach(() => {
    restore();
  });

  test("HOME / PATH 等の allowlist 内 env は含まれる", () => {
    process.env.HOME = "/tmp/home-test";
    process.env.PATH = "/usr/bin:/bin";
    process.env.LANG = "en_US.UTF-8";
    const env = buildCsaEnv();
    expect(env.HOME).toBe("/tmp/home-test");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  test("ANTHROPIC_API_KEY は含まれない (CSA に渡さない)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
    const env = buildCsaEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("GITHUB_TOKEN / GH_TOKEN は含まれない", () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    process.env.GH_TOKEN = "gh_fake";
    const env = buildCsaEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("SSH_AUTH_SOCK は含まれない (= 1Password sock 等の agent 経路を遮断)", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    const env = buildCsaEnv();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  test("AWS / OpenAI credentials も含まれない", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.OPENAI_API_KEY = "sk-fake";
    const env = buildCsaEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("CLAUDE_CONFIG_DIR は含まれる (= テスト隔離用、CSA の session discovery を tempDir に向ける)", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-test";
    const env = buildCsaEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-test");
  });

  test("未設定 env はキー自体が結果に出ない", () => {
    delete process.env.LANG;
    const env = buildCsaEnv();
    expect("LANG" in env).toBe(false);
  });
});
