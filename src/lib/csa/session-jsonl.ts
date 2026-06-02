/**
 * JSONL streaming parser for Claude session files.
 * Designed to handle large files (hundreds of MB) without OOM
 * by processing one line at a time via streaming.
 */

/**
 * Maximum size (in UTF-8 bytes) for a single JSONL line. Lines exceeding this
 * are skipped with a warning instead of being buffered to completion. 10 MiB
 * is well above any legitimate session line (largest observed so far: well
 * under 1 MiB) and below the threshold where buffering one line could OOM a
 * small worker. Adversarial / corrupted inputs with no newline can otherwise
 * grow `buffer` unbounded.
 *
 * Design rationale: skip + log instead of throw. A single oversized line in a
 * session jsonl should not abort the whole session processing pipeline; the
 * rest of the lines may still be usable.
 */
export const MAX_JSONL_LINE_BYTES = 10 * 1024 * 1024;

/**
 * Stream-parse a JSONL file, yielding each parsed JSON object.
 * Empty lines are skipped.
 *
 * Lines whose UTF-8 byte length exceeds `maxLineBytes` (default
 * {@link MAX_JSONL_LINE_BYTES}) are skipped with a `console.warn` and
 * processing continues with the next line. The override is intended for
 * tests; production callers should use the default.
 */
export async function* streamSessionLines(
  filePath: string,
  maxLineBytes: number = MAX_JSONL_LINE_BYTES,
): AsyncGenerator<unknown> {
  const file = Bun.file(filePath);
  const stream = file.stream();
  const decoder = new TextDecoder();
  let buffer = "";
  // When the in-progress line (no newline seen yet) exceeds the cap, drop the
  // rest of that line until we see a newline. This bounds memory regardless
  // of adversarial input.
  let skipUntilNewline = false;

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    if (skipUntilNewline) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) {
        // Still no newline in sight — drop the buffer to keep memory bounded.
        buffer = "";
        continue;
      }
      // Found newline; discard everything up to and including it, resume normal
      // parsing on the remainder.
      buffer = buffer.slice(nl + 1);
      skipUntilNewline = false;
    }

    const lines = buffer.split("\n");
    // Keep the last element as it may be incomplete
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const byteLength = Buffer.byteLength(line, "utf8");
      if (byteLength > maxLineBytes) {
        console.warn(
          `[session-jsonl] Skipping oversized line in ${filePath} (${byteLength} bytes > ${maxLineBytes} cap)`,
        );
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        yield JSON.parse(trimmed) as unknown;
      } catch {
        // Skip broken JSON lines silently (e.g. truncated writes)
      }
    }

    // If the *in-progress* tail buffer has already exceeded the cap without
    // any newline, switch to skip mode and drop what we have.
    if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
      console.warn(
        `[session-jsonl] Skipping oversized line in ${filePath} (in-progress > ${maxLineBytes} bytes, no newline yet)`,
      );
      buffer = "";
      skipUntilNewline = true;
    }
  }

  // Process remaining buffer
  buffer += decoder.decode();
  if (skipUntilNewline) {
    return;
  }
  const tailByteLength = Buffer.byteLength(buffer, "utf8");
  if (tailByteLength > maxLineBytes) {
    console.warn(
      `[session-jsonl] Skipping oversized trailing line in ${filePath} (${tailByteLength} bytes > ${maxLineBytes} cap)`,
    );
    return;
  }
  const trimmed = buffer.trim();
  if (trimmed.length > 0) {
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      // Skip broken last line silently (e.g. incomplete write)
    }
  }
}

/**
 * Count non-empty lines in a JSONL file using streaming.
 */
export async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const file = Bun.file(filePath);
  const stream = file.stream();
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length > 0) count++;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) count++;

  return count;
}
