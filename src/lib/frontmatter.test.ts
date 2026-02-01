import { describe, expect, test } from 'bun:test'
import { parseFrontmatter, generateFrontmatter } from './frontmatter.ts'

describe('parseFrontmatter', () => {
  test('parses basic key: value pairs', () => {
    const content = `---
title: Hello World
count: 42
---
Body text here.`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({ title: 'Hello World', count: 42 })
    expect(result.body).toBe('Body text here.')
  })

  test('parses nested keys (2 levels)', () => {
    const content = `---
match:
  min_lines: 100
  max_lines: 500
priority: 10
---
Prompt text.`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({
      match: { min_lines: 100, max_lines: 500 },
      priority: 10,
    })
    expect(result.body).toBe('Prompt text.')
  })

  test('converts numeric values to number', () => {
    const content = `---
count: 42
negative: -5
decimal: 3.14
---
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.count).toBe(42)
    expect(result.frontmatter.negative).toBe(-5)
    expect(result.frontmatter.decimal).toBe(3.14)
  })

  test('converts boolean values', () => {
    const content = `---
enabled: true
disabled: false
---
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.enabled).toBe(true)
    expect(result.frontmatter.disabled).toBe(false)
  })

  test('strips quotes from quoted strings', () => {
    const content = `---
single: 'hello world'
double: "foo bar"
---
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.single).toBe('hello world')
    expect(result.frontmatter.double).toBe('foo bar')
  })

  test('returns empty frontmatter and full body when no --- delimiters', () => {
    const content = 'Just plain text\nwith multiple lines.'
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('Just plain text\nwith multiple lines.')
  })

  test('ignores comment lines in frontmatter', () => {
    const content = `---
# This is a comment
key: value
  # Indented comment
---
Body`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({ key: 'value' })
  })

  test('handles empty frontmatter block', () => {
    const content = `---
---
Body only`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('Body only')
  })

  test('parses real recipe-diary.md format', () => {
    const content = `---
match:
  min_lines: 100
  min_age: 7200
---
Write a diary.`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({
      match: { min_lines: 100, min_age: 7200 },
    })
    expect(result.body).toBe('Write a diary.')
  })

  test('parses recipe-diary-work.md format with top-level and nested keys', () => {
    const content = `---
match:
  project: "*/emeradaco/*"
  min_lines: 50
priority: 10
---
Body text.`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({
      match: { project: '*/emeradaco/*', min_lines: 50 },
      priority: 10,
    })
  })

  test('parses output_mode as string', () => {
    const content = `---
output_mode: stdout
---
Body`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.output_mode).toBe('stdout')
  })
})

describe('generateFrontmatter', () => {
  test('generates basic frontmatter string', () => {
    const result = generateFrontmatter({ title: 'Hello', count: 42, enabled: true })
    expect(result).toBe(`---\ntitle: Hello\ncount: 42\nenabled: true\n---\n`)
  })

  test('roundtrip: generate then parse simple data', () => {
    const data = { name: 'test', priority: 5, active: false }
    const generated = generateFrontmatter(data)
    const parsed = parseFrontmatter(generated + '\nBody text')
    expect(parsed.frontmatter).toEqual(data)
    expect(parsed.body).toBe('Body text')
  })
})
