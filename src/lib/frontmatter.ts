/**
 * Simple YAML frontmatter parser (no external YAML dependency).
 * Supports up to 2 levels of nesting.
 */

function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  // Boolean
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // Quoted string (single or double quotes)
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  // Number
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed)
  }
  // Plain string
  return trimmed
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const lines = content.split('\n')

  // Must start with ---
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content }
  }

  // Find closing ---
  let closingIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIndex = i
      break
    }
  }

  if (closingIndex === -1) {
    return { frontmatter: {}, body: content }
  }

  const fmLines = lines.slice(1, closingIndex)
  const body = lines.slice(closingIndex + 1).join('\n')

  const frontmatter: Record<string, unknown> = {}
  let currentParent: string | null = null

  for (const line of fmLines) {
    // Skip blank lines and comment lines
    const stripped = line.trimStart()
    if (stripped === '' || stripped.startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const colonIndex = stripped.indexOf(':')
    if (colonIndex === -1) continue

    const key = stripped.slice(0, colonIndex).trim()
    const valueRaw = stripped.slice(colonIndex + 1)
    // Strip inline comments: find # preceded by whitespace, not inside quotes
    const valueNoComment = stripInlineComment(valueRaw)
    const valueTrimmed = valueNoComment.trim()

    if (indent >= 2 && currentParent !== null) {
      // Nested key under currentParent
      const parentObj = frontmatter[currentParent]
      if (typeof parentObj === 'object' && parentObj !== null) {
        ;(parentObj as Record<string, unknown>)[key] = parseValue(valueTrimmed)
      }
    } else if (valueTrimmed === '') {
      // Parent key with no value — next indented lines are children
      currentParent = key
      frontmatter[key] = {}
    } else {
      // Top-level key with value
      currentParent = null
      frontmatter[key] = parseValue(valueTrimmed)
    }
  }

  return { frontmatter, body: body.replace(/^\n/, '') }
}

function stripInlineComment(value: string): string {
  // Strip inline comments: # preceded by at least one space,
  // but not inside single or double quotes
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === '#' && !inSingle && !inDouble && i > 0 && value[i - 1] === ' ') {
      return value.slice(0, i - 1)
    }
  }
  return value
}

export function generateFrontmatter(data: Record<string, string | number | boolean>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${String(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}
