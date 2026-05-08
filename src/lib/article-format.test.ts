import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  C,
  formatDuration,
  formatSmartSize,
  formatTimestamp,
  oscLink,
  parseProject,
  stripAnsi,
} from "./article-format.ts";

describe("article-format", () => {
  // The colorized formatters are no-ops unless shouldUseColor() returns true.
  // `bun test` runs without a TTY, so we force colors on for the suite.
  let suiteIsTTYDescriptor: PropertyDescriptor | undefined;
  let suiteOriginalForceColor: string | undefined;
  let suiteOriginalNoColor: string | undefined;
  let suiteOriginalCI: string | undefined;

  beforeAll(() => {
    suiteIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    suiteOriginalForceColor = process.env.FORCE_COLOR;
    suiteOriginalNoColor = process.env.NO_COLOR;
    suiteOriginalCI = process.env.CI;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    delete process.env.CI;
  });

  afterAll(() => {
    if (suiteIsTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", suiteIsTTYDescriptor);
    }
    if (suiteOriginalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = suiteOriginalForceColor;
    if (suiteOriginalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = suiteOriginalNoColor;
    if (suiteOriginalCI === undefined) delete process.env.CI;
    else process.env.CI = suiteOriginalCI;
  });

  describe("stripAnsi", () => {
    test("removes ANSI SGR codes", () => {
      expect(stripAnsi("\x1b[0;32mhello\x1b[0m")).toBe("hello");
    });

    test("returns plain text unchanged", () => {
      expect(stripAnsi("hello world")).toBe("hello world");
    });

    test("removes multiple sequences", () => {
      expect(stripAnsi("\x1b[31ma\x1b[0m\x1b[32mb\x1b[0m")).toBe("ab");
    });
  });

  describe("C (color proxy)", () => {
    test("returns ANSI codes when colors enabled", () => {
      expect(C.red).toBe("\x1b[0;31m");
      expect(C.reset).toBe("\x1b[0m");
    });

    test("returns empty string for unknown keys", () => {
      // @ts-expect-error – probing dynamic access
      expect(C.unknownKey).toBe("");
    });
  });

  describe("formatSmartSize", () => {
    test("returns 0.1K for very small files", () => {
      expect(stripAnsi(formatSmartSize(0))).toBe("0.1K");
      expect(stripAnsi(formatSmartSize(50))).toBe("0.1K");
      expect(stripAnsi(formatSmartSize(102))).toBe("0.1K");
    });

    test("returns fractional K for < 10K", () => {
      expect(stripAnsi(formatSmartSize(1024))).toBe("1.0K");
      expect(stripAnsi(formatSmartSize(1536))).toBe("1.5K");
      expect(stripAnsi(formatSmartSize(6144))).toBe("6.0K");
    });

    test("returns integer K for >= 10K", () => {
      expect(stripAnsi(formatSmartSize(10240))).toBe("10K");
      expect(stripAnsi(formatSmartSize(13312))).toBe("13K");
    });

    test("uses blue for small K files", () => {
      expect(formatSmartSize(1024)).toContain("\x1b[0;34m");
    });

    test("uses yellow for >= 500K files", () => {
      expect(formatSmartSize(500 * 1024)).toContain("\x1b[0;33m");
    });

    test("returns fractional M for >= 1M and < 10M", () => {
      expect(stripAnsi(formatSmartSize(1048576))).toBe("1.0M");
      expect(stripAnsi(formatSmartSize(5767168))).toBe("5.5M");
    });

    test("uses blue for <= 2M", () => {
      expect(formatSmartSize(2 * 1024 * 1024)).toContain("\x1b[0;34m");
    });

    test("uses red for > 2M", () => {
      expect(formatSmartSize(2 * 1024 * 1024 + 1)).toContain("\x1b[0;31m");
    });

    test("returns integer M for >= 10M", () => {
      expect(stripAnsi(formatSmartSize(10485760))).toBe("10M");
    });

    test("returns fractional G for >= 1G and < 10G", () => {
      expect(stripAnsi(formatSmartSize(1073741824))).toBe("1.0G");
      expect(stripAnsi(formatSmartSize(2684354560))).toBe("2.5G");
    });

    test("returns integer G for >= 10G", () => {
      expect(stripAnsi(formatSmartSize(10737418240))).toBe("10G");
    });

    test("uses red for G files", () => {
      expect(formatSmartSize(1073741824)).toContain("\x1b[0;31m");
    });
  });

  describe("formatDuration", () => {
    test("formats days + hours", () => {
      const dur = 3 * 86400 + 12 * 3600;
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe("3d12h");
    });

    test("formats hours + minutes", () => {
      const dur = 2 * 3600 + 30 * 60;
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe("2h30m");
    });

    test("formats minutes + seconds", () => {
      const dur = 5 * 60 + 30;
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe("5m30s");
    });

    test("formats sub-minute with dim 0m prefix", () => {
      const dur = 42;
      const result = formatDuration(0, dur * 1000);
      expect(stripAnsi(result)).toBe("0m42s");
      // Should contain ANSI codes for the 0m part
      expect(result).toContain("\x1b[");
    });

    test("formats 0 seconds", () => {
      const result = formatDuration(0, 0);
      expect(stripAnsi(result)).toBe("0m00s");
    });

    test("returns - for negative duration", () => {
      expect(formatDuration(1000, 0)).toBe("-");
    });

    test("uses red for day-spanning durations", () => {
      const dur = 86400;
      expect(formatDuration(0, dur * 1000)).toContain("\x1b[0;31m");
    });

    test("uses yellow for hour-spanning durations", () => {
      const dur = 3600;
      expect(formatDuration(0, dur * 1000)).toContain("\x1b[0;33m");
    });

    test("uses green for minute-spanning durations", () => {
      const dur = 60;
      expect(formatDuration(0, dur * 1000)).toContain("\x1b[0;32m");
    });
  });

  describe("formatTimestamp", () => {
    test("formats UTC midnight as JST 09:00 with / separator", () => {
      const date = new Date("2026-03-07T00:00:00Z");
      const result = formatTimestamp(date);
      expect(stripAnsi(result)).toBe("2026/03/07T09:00");
    });

    test("handles date rollover", () => {
      const date = new Date("2026-03-07T15:00:00Z");
      const result = formatTimestamp(date);
      expect(stripAnsi(result)).toBe("2026/03/08T00:00");
    });

    test("contains ANSI color code for T separator only", () => {
      const date = new Date("2026-03-07T00:00:00Z");
      const result = formatTimestamp(date);
      expect(result).toContain("\x1b[0;90m"); // blackBright for T
      expect(result).toContain("\x1b[0m"); // reset
    });

    test("plain text is always 16 characters", () => {
      const date = new Date("2026-01-02T03:04:05Z");
      expect(stripAnsi(formatTimestamp(date))).toHaveLength(16);
    });
  });

  describe("parseProject", () => {
    test("extracts matchPath from standard github repos path", () => {
      const result = parseProject(
        "/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main",
      );
      expect(result.matchPath).toBe("kawaz/idea-storage/main");
      expect(stripAnsi(result.displayPath)).toBe("kawaz/idea-storage/main");
    });

    test("extracts matchPath from dotfiles repos path", () => {
      const result = parseProject(
        "/Users/kawaz/.dotfiles/local/share/repos/github.com/emeradaco/antenna/main",
      );
      expect(result.matchPath).toBe("emeradaco/antenna/main");
    });

    test("handles path ending at repo level", () => {
      const result = parseProject("/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage");
      expect(result.matchPath).toBe("kawaz/idea-storage");
    });

    test("handles trailing slash", () => {
      const result = parseProject(
        "/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main/",
      );
      expect(result.matchPath).toBe("kawaz/idea-storage/main");
    });

    test("includes host prefix for non-github hosts", () => {
      const result = parseProject("/home/user/repos/gitlab.com/org/project/main");
      expect(result.matchPath).toBe("gitlab.com/org/project/main");
    });

    test("includes full sub-path in matchPath", () => {
      const result = parseProject(
        "/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main/src/lib",
      );
      expect(result.matchPath).toBe("kawaz/idea-storage/main/src/lib");
      expect(stripAnsi(result.displayPath)).toBe("kawaz/idea-storage/main/src/lib");
    });

    test("fallback: returns full path for non-repos path", () => {
      const result = parseProject("/some/random/path/owner/repo");
      expect(result.matchPath).toBe("/some/random/path/owner/repo");
      expect(stripAnsi(result.displayPath)).toBe("/some/random/path/owner/repo");
    });

    test("returns empty string for empty input", () => {
      const result = parseProject("");
      expect(result.matchPath).toBe("");
      expect(stripAnsi(result.displayPath)).toBe("");
    });
  });

  describe("oscLink", () => {
    test("wraps text in OSC 8 hyperlink when colors enabled", () => {
      const result = oscLink("file:///tmp/foo", "[F]");
      expect(result).toContain("\x1b]8;;file:///tmp/foo\x07[F]\x1b]8;;\x07");
    });
  });

  describe("NO_COLOR / CI suppression", () => {
    const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR", "CI"] as const;
    const originalEnv: Record<string, string | undefined> = {};
    let isTTYDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      for (const k of ENV_KEYS) {
        originalEnv[k] = process.env[k];
        delete process.env[k];
      }
      isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      // Force TTY=true so the only thing toggling colors here is the env
      // var under test (NO_COLOR / CI).
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        const v = originalEnv[k];
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
      }
    });

    // oxlint-disable-next-line no-control-regex -- intentional: detect any ANSI escape
    const ANY_ANSI = /\x1b\[/;
    // oxlint-disable-next-line no-control-regex -- intentional: detect OSC 8 hyperlinks
    const OSC_LINK = /\x1b\]8;;/;

    test("formatSmartSize emits no ANSI codes when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      const out = formatSmartSize(1024);
      expect(ANY_ANSI.test(out)).toBe(false);
      expect(out).toBe("1.0K");
    });

    test("formatDuration emits no ANSI codes when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      const out = formatDuration(0, 90 * 1000);
      expect(ANY_ANSI.test(out)).toBe(false);
      expect(out).toBe("1m30s");
    });

    test("formatTimestamp emits no ANSI codes when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      const date = new Date("2026-03-07T00:00:00Z");
      const out = formatTimestamp(date);
      expect(ANY_ANSI.test(out)).toBe(false);
      expect(out).toBe("2026/03/07T09:00");
    });

    test("parseProject displayPath has no ANSI codes when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      const { displayPath } = parseProject(
        "/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main",
      );
      expect(ANY_ANSI.test(displayPath)).toBe(false);
      expect(OSC_LINK.test(displayPath)).toBe(false);
      expect(displayPath).toBe("kawaz/idea-storage/main");
    });

    test("oscLink suppresses escape sequences when NO_COLOR is set", () => {
      process.env.NO_COLOR = "1";
      expect(oscLink("file:///tmp/foo", "[F]")).toBe("[F]");
    });

    test("CI=true also disables ANSI output", () => {
      process.env.CI = "true";
      expect(ANY_ANSI.test(formatSmartSize(1024))).toBe(false);
      expect(ANY_ANSI.test(formatDuration(0, 90 * 1000))).toBe(false);
    });

    test("FORCE_COLOR=1 keeps ANSI output even when CI is set", () => {
      process.env.CI = "true";
      process.env.FORCE_COLOR = "1";
      expect(ANY_ANSI.test(formatSmartSize(1024))).toBe(true);
    });
  });
});
