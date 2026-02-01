import { describe, expect, test } from 'bun:test'
import { splitConversation } from './chunker.ts'

describe('splitConversation', () => {
  test('returns single chunk when text is under maxChars', () => {
    const text = '[2024-01-01T10:00:00] USER: Hello\n[2024-01-01T10:00:05] ASSISTANT: Hi there!'
    const chunks = splitConversation(text)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  test('splits at USER: boundary when exceeding maxChars', () => {
    const line1 = '[2024-01-01T10:00:00] USER: First message'
    const line2 = '[2024-01-01T10:00:05] ASSISTANT: First response'
    const line3 = '[2024-01-01T10:01:00] USER: Second message'
    const line4 = '[2024-01-01T10:01:05] ASSISTANT: Second response'
    const text = [line1, line2, line3, line4].join('\n')

    // Set maxChars low enough to force a split after first USER/ASSISTANT pair
    const chunks = splitConversation(text, 50)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // First chunk should contain the first user message
    expect(chunks[0]).toContain('First message')
    // Second chunk should start with USER:
    expect(chunks[1]).toContain('Second message')
  })

  test('handles USER: without timestamp prefix', () => {
    const text = 'USER: Hello\nASSISTANT: Hi\nUSER: Again\nASSISTANT: Sure'
    const chunks = splitConversation(text, 20)

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toContain('Hello')
  })

  test('keeps single USER block in one chunk even if over maxChars', () => {
    const longContent = 'a'.repeat(300)
    const text = `[2024-01-01T10:00:00] USER: ${longContent}`
    const chunks = splitConversation(text, 100)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  test('handles multiple USER blocks correctly', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      `[2024-01-01T10:0${i}:00] USER: Message ${i}\n[2024-01-01T10:0${i}:05] ASSISTANT: Response ${i}`
    )
    const text = blocks.join('\n')

    // Force splits by setting small maxChars
    const chunks = splitConversation(text, 80)

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk after the first should start at a USER: boundary line
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).toMatch(/^\[.*\] USER:|^USER:/)
    }
  })

  test('uses default maxChars of 200000', () => {
    const text = 'USER: Short message'
    const chunks = splitConversation(text)

    expect(chunks).toHaveLength(1)
  })

  test('returns single chunk for empty text', () => {
    const chunks = splitConversation('')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('')
  })

  test('does not split when exactly at maxChars', () => {
    const content = 'a'.repeat(100)
    const text = `USER: ${content}`
    const chunks = splitConversation(text, text.length)

    expect(chunks).toHaveLength(1)
  })

  test('preserves all content across chunks', () => {
    const lines = [
      '[2024-01-01T10:00:00] USER: First',
      '[2024-01-01T10:00:05] ASSISTANT: Response1',
      '[2024-01-01T10:01:00] USER: Second',
      '[2024-01-01T10:01:05] ASSISTANT: Response2',
      '[2024-01-01T10:02:00] USER: Third',
      '[2024-01-01T10:02:05] ASSISTANT: Response3',
    ]
    const text = lines.join('\n')
    const chunks = splitConversation(text, 60)
    const rejoined = chunks.join('')

    // All original content should be present
    expect(rejoined).toContain('First')
    expect(rejoined).toContain('Response1')
    expect(rejoined).toContain('Second')
    expect(rejoined).toContain('Response2')
    expect(rejoined).toContain('Third')
    expect(rejoined).toContain('Response3')
  })
})
