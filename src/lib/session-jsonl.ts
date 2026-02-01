/**
 * JSONL streaming parser for Claude session files.
 * Designed to handle large files (hundreds of MB) without OOM
 * by processing one line at a time via streaming.
 */

/**
 * Stream-parse a JSONL file, yielding each parsed JSON object.
 * Empty lines are skipped.
 */
export async function* streamSessionLines(filePath: string): AsyncGenerator<unknown> {
  const file = Bun.file(filePath)
  const stream = file.stream()
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    // Keep the last element as it may be incomplete
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      yield JSON.parse(trimmed) as unknown
    }
  }

  // Process remaining buffer
  buffer += decoder.decode()
  const trimmed = buffer.trim()
  if (trimmed.length > 0) {
    yield JSON.parse(trimmed) as unknown
  }
}

/**
 * Count non-empty lines in a JSONL file using streaming.
 */
export async function countLines(filePath: string): Promise<number> {
  let count = 0
  const file = Bun.file(filePath)
  const stream = file.stream()
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim().length > 0) count++
    }
  }

  buffer += decoder.decode()
  if (buffer.trim().length > 0) count++

  return count
}
