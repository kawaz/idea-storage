import { describe, expect, test } from "bun:test";
import {
  formatSmartSize,
  formatAge,
  toJSTISOString,
  formatDuration,
  formatTimestamp,
} from "./format.ts";

describe("formatSmartSize", () => {
  test("returns 0.1K for very small values", () => {
    expect(formatSmartSize(10)).toBe("0.1K");
    expect(formatSmartSize(50)).toBe("0.1K");
  });

  test("formats KB with one decimal for < 10K", () => {
    expect(formatSmartSize(1024)).toBe("1.0K");
    expect(formatSmartSize(5 * 1024)).toBe("5.0K");
    expect(formatSmartSize(9.5 * 1024)).toBe("9.5K");
  });

  test("formats KB rounded for >= 10K", () => {
    expect(formatSmartSize(10 * 1024)).toBe("10K");
    expect(formatSmartSize(100 * 1024)).toBe("100K");
  });

  test("formats MB with one decimal for < 10M", () => {
    expect(formatSmartSize(1024 * 1024)).toBe("1.0M");
    expect(formatSmartSize(5.5 * 1024 * 1024)).toBe("5.5M");
  });

  test("formats MB rounded for >= 10M", () => {
    expect(formatSmartSize(10 * 1024 * 1024)).toBe("10M");
    expect(formatSmartSize(50 * 1024 * 1024)).toBe("50M");
  });

  test("formats GB with one decimal for < 10G", () => {
    expect(formatSmartSize(1024 * 1024 * 1024)).toBe("1.0G");
    expect(formatSmartSize(2.5 * 1024 * 1024 * 1024)).toBe("2.5G");
  });

  test("formats GB rounded for >= 10G", () => {
    expect(formatSmartSize(10 * 1024 * 1024 * 1024)).toBe("10G");
  });
});

describe("formatAge", () => {
  test("formats seconds", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(30)).toBe("30s");
    expect(formatAge(59)).toBe("59s");
  });

  test("formats minutes", () => {
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(120)).toBe("2m");
    expect(formatAge(3599)).toBe("59m");
  });

  test("formats hours", () => {
    expect(formatAge(3600)).toBe("1h");
    expect(formatAge(7200)).toBe("2h");
    expect(formatAge(86399)).toBe("23h");
  });

  test("formats days", () => {
    expect(formatAge(86400)).toBe("1d");
    expect(formatAge(172800)).toBe("2d");
    expect(formatAge(864000)).toBe("10d");
  });
});

describe("toJSTISOString", () => {
  test("formats UTC midnight as JST 09:00", () => {
    const date = new Date("2024-01-15T00:00:00Z");
    expect(toJSTISOString(date)).toBe("2024-01-15T09:00:00+09:00");
  });

  test("formats UTC 15:00 as JST next day 00:00", () => {
    const date = new Date("2024-01-15T15:00:00Z");
    expect(toJSTISOString(date)).toBe("2024-01-16T00:00:00+09:00");
  });

  test("pads single-digit months and days", () => {
    const date = new Date("2024-03-05T01:02:03Z");
    expect(toJSTISOString(date)).toBe("2024-03-05T10:02:03+09:00");
  });
});

describe("formatDuration", () => {
  test("returns dash for negative duration", () => {
    expect(formatDuration(1000, 500)).toBe("-");
  });

  test("formats seconds only (< 1 minute)", () => {
    expect(formatDuration(0, 15000)).toBe("0m15s");
    expect(formatDuration(0, 5000)).toBe("0m05s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(0, 90000)).toBe("1m30s");
    expect(formatDuration(0, 45 * 60 * 1000 + 30 * 1000)).toBe("45m30s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(0, 5 * 3600 * 1000 + 30 * 60 * 1000)).toBe("5h30m");
    expect(formatDuration(0, 3600 * 1000)).toBe("1h00m");
  });

  test("formats days and hours", () => {
    expect(formatDuration(0, 86400 * 1000 + 2 * 3600 * 1000)).toBe("1d02h");
    expect(formatDuration(0, 3 * 86400 * 1000)).toBe("3d00h");
  });

  test("works with arbitrary start/end", () => {
    const start = 1000000;
    const end = start + 90000;
    expect(formatDuration(start, end)).toBe("1m30s");
  });
});

describe("formatTimestamp", () => {
  test("formats date in JST", () => {
    const date = new Date("2024-01-15T00:00:00Z");
    expect(formatTimestamp(date)).toBe("2024/01/15T09:00");
  });

  test("formats date crossing day boundary in JST", () => {
    const date = new Date("2024-01-15T15:30:00Z");
    expect(formatTimestamp(date)).toBe("2024/01/16T00:30");
  });

  test("pads single-digit values", () => {
    const date = new Date("2024-03-05T00:05:00Z");
    expect(formatTimestamp(date)).toBe("2024/03/05T09:05");
  });
});
