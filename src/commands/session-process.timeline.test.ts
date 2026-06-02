import { describe, expect, test } from "bun:test";
import { trimTimelineForFork } from "./session-process.ts";
import { isValidCsaTimeline, countTimelineSeparators } from "../lib/csa.ts";

describe("trimTimelineForFork", () => {
  const sampleTimeline = `---
session: test-session
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message 1
Some user content

---
2024-01-01T10:00:05+09:00 Tbbb22222 Assistant reply 1
Some assistant content

---
2024-01-01T10:01:00+09:00 Uccc33333 User message 2
More user content

---
2024-01-01T10:01:10+09:00 Tddd44444 Assistant reply 2
More assistant content

---
2024-01-01T11:00:00+09:00 Ueee55555 Fork user message
Fork content here

---
2024-01-01T11:00:10+09:00 Tfff66666 Fork assistant reply
Fork reply content`;

  test("firstNewUuid の先頭8文字でブロックを特定し、そのブロック以降を返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "eee55555-0000-0000-0000-000000000000");
    expect(result).toContain("Ueee55555");
    expect(result).toContain("Fork user message");
    expect(result).toContain("Tfff66666");
    expect(result).toContain("Fork reply content");
    expect(result).not.toContain("Uaaa11111");
    expect(result).not.toContain("Uccc33333");
    expect(result).not.toContain("Tddd44444");
  });

  test("firstNewUuid が空の場合、元のタイムラインをそのまま返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "");
    expect(result).toBe(sampleTimeline);
  });

  test("firstNewUuid がタイムラインに見つからない場合、元のタイムラインをそのまま返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "zzzzzzzz-0000-0000-0000-000000000000");
    expect(result).toBe(sampleTimeline);
  });

  test("firstNewUuid が最初のブロックの場合、ヘッダー以降全て返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "aaa11111-0000-0000-0000-000000000000");
    expect(result).toContain("Uaaa11111");
    expect(result).toContain("Tfff66666");
  });

  test("メッセージ本文中に同じ8文字hexが含まれても誤マッチしない", () => {
    const timelineWithContent = `---
session: test
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message
The commit hash is eee55555abc and some content

---
2024-01-01T11:00:00+09:00 Ueee55555 Real fork point
Fork content here`;

    const result = trimTimelineForFork(timelineWithContent, "eee55555-0000-0000-0000-000000000000");
    expect(result).toContain("Ueee55555");
    expect(result).not.toContain("Uaaa11111");
  });
});

describe("processSession CSA timeline validation (#17)", () => {
  test("`---` セパレータを 1 つも含まない出力は invalid と判定される", () => {
    const malformed = "error: something went wrong while building timeline\n";
    expect(countTimelineSeparators(malformed)).toBe(0);
    expect(isValidCsaTimeline(malformed)).toBe(false);
  });

  test("`---` が1個しかない（閉じ --- 欠落）出力も invalid と判定される", () => {
    const malformed = `---
command: claude-session-analysis timeline foo
2025-01-01T00:00:00+00:00 Uaaa11111 truncated output`;
    expect(countTimelineSeparators(malformed)).toBe(1);
    expect(isValidCsaTimeline(malformed)).toBe(false);
  });

  test("`---` が2個（frontmatter open + close）以上あれば valid", () => {
    const valid = `---
session: real
---
2025-01-01T00:00:00+00:00 Uaaa11111 hello`;
    expect(countTimelineSeparators(valid)).toBe(2);
    expect(isValidCsaTimeline(valid)).toBe(true);
  });

  test("空文字列は invalid (セパレータ 0 個)", () => {
    expect(countTimelineSeparators("")).toBe(0);
    expect(isValidCsaTimeline("")).toBe(false);
  });
});
