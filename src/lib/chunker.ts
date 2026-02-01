/**
 * Chunk splitter for conversation text.
 * TypeScript port of split_conversation from idea-storage-session-processor.sh.
 *
 * Splits at USER: message boundaries to keep conversation turns together.
 */

/** Default maximum characters per chunk (200K) */
const DEFAULT_MAX_CHARS = 200_000

/**
 * Pattern matching USER: boundaries.
 * Matches:
 *   - "[timestamp] USER: ..."   (with timestamp prefix)
 *   - "USER: ..."               (without timestamp)
 */
const USER_BOUNDARY_PATTERN = /^\[.*\] USER:|^USER:/

/**
 * Split conversation text into chunks at USER: message boundaries.
 *
 * - If the entire text is within maxChars, returns a single chunk.
 * - Splits at lines matching USER: boundary when accumulated size exceeds maxChars.
 * - A single USER block exceeding maxChars is kept as one chunk (not split mid-block).
 */
export function splitConversation(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text]
  }

  const lines = text.split('\n')
  const chunks: string[] = []
  let currentLines: string[] = []
  let currentSize = 0

  for (const line of lines) {
    // Check if this line starts a new USER: boundary
    if (currentSize > maxChars && USER_BOUNDARY_PATTERN.test(line)) {
      // Flush current chunk
      chunks.push(currentLines.join('\n'))
      currentLines = []
      currentSize = 0
    }

    currentLines.push(line)
    // +1 for the newline character
    currentSize += line.length + 1
  }

  // Flush remaining
  if (currentLines.length > 0) {
    chunks.push(currentLines.join('\n'))
  }

  return chunks
}
