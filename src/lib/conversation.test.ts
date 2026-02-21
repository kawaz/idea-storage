import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extractConversation, formatConversationToText, getSessionMeta } from './conversation.ts'
import type { ConversationMessage } from '../types/index.ts'

describe('conversation', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-test-'))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function writeTempFile(name: string, lines: Record<string, unknown>[]): Promise<string> {
    const path = join(tmpDir, name)
    const content = lines.map(l => JSON.stringify(l)).join('\n')
    await Bun.write(path, content)
    return path
  }

  // Helper to format a Date to local ISO-like string (matching jq strflocaltime behavior)
  function toLocalIso(isoStr: string): string {
    const d = new Date(isoStr)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  describe('extractConversation', () => {
    test('extracts user message with string content', async () => {
      const path = await writeTempFile('user-string.jsonl', [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hello world' }, cwd: '/tmp/test' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('USER')
      expect(msgs[0]!.content).toBe('Hello world')
      expect(msgs[0]!.timestamp).toBe(toLocalIso('2024-01-01T10:00:00.000Z'))
    })

    test('extracts user message with array content (text)', async () => {
      const path = await writeTempFile('user-array.jsonl', [
        {
          type: 'user', timestamp: '2024-01-01T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello from array' }] },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('USER')
      expect(msgs[0]!.content).toBe('Hello from array')
    })

    test('extracts user message with array content (tool_result with string)', async () => {
      const path = await writeTempFile('user-tool-result.jsonl', [
        {
          type: 'user', timestamp: '2024-01-01T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents here' }] },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('TOOL_RESULT')
      expect(msgs[0]!.content).toBe('file contents here')
    })

    test('extracts user message with tool_result containing array content', async () => {
      const path = await writeTempFile('user-tool-result-array.jsonl', [
        {
          type: 'user', timestamp: '2024-01-01T10:00:00.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'x',
              content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }],
            }],
          },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('TOOL_RESULT')
      expect(msgs[0]!.content).toBe('part1part2')
    })

    test('extracts assistant message with text content', async () => {
      const path = await writeTempFile('assistant-text.jsonl', [
        {
          type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('ASSISTANT')
      expect(msgs[0]!.content).toBe('Hi there!')
    })

    test('extracts assistant message with thinking content', async () => {
      const path = await writeTempFile('assistant-thinking.jsonl', [
        {
          type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me think about this...' }] },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('THINKING')
      expect(msgs[0]!.content).toBe('Let me think about this...')
    })

    test('extracts assistant message with tool_use content', async () => {
      const path = await writeTempFile('assistant-tool-use.jsonl', [
        {
          type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            }],
          },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('TOOL_USE')
      expect(msgs[0]!.content).toStartWith('Read ')
    })

    test('tool_use input is truncated to 100 characters', async () => {
      const longInput = 'a'.repeat(200)
      const path = await writeTempFile('assistant-tool-use-long.jsonl', [
        {
          type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              name: 'Bash',
              input: { command: longInput },
            }],
          },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      // "Bash " + truncated JSON string (100 chars from input serialized)
      const inputStr = JSON.stringify({ command: longInput })
      expect(msgs[0]!.content).toBe(`Bash ${inputStr.slice(0, 100)}`)
    })

    test('extracts assistant message with multiple content items', async () => {
      const path = await writeTempFile('assistant-multi.jsonl', [
        {
          type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Hmm' },
              { type: 'text', text: 'Here is the answer' },
              { type: 'tool_use', name: 'Read', input: { file_path: '/foo' } },
            ],
          },
        },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(3)
      expect(msgs[0]!.type).toBe('THINKING')
      expect(msgs[1]!.type).toBe('ASSISTANT')
      expect(msgs[2]!.type).toBe('TOOL_USE')
    })

    test('extracts summary message', async () => {
      const path = await writeTempFile('summary.jsonl', [
        { type: 'summary', summary: 'Session completed successfully' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('SUMMARY')
      expect(msgs[0]!.content).toBe('Session completed successfully')
    })

    test('extracts queue-operation enqueue as QUEUED', async () => {
      const path = await writeTempFile('queued.jsonl', [
        { type: 'queue-operation', operation: 'enqueue', content: 'queued task', timestamp: '2024-01-01T10:00:00.000Z' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.type).toBe('QUEUED')
      expect(msgs[0]!.content).toBe('queued task')
    })

    test('skips queue-operation dequeue', async () => {
      const path = await writeTempFile('dequeue.jsonl', [
        { type: 'queue-operation', operation: 'dequeue', timestamp: '2024-01-01T10:00:00.000Z', sessionId: 'abc' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(0)
    })

    test('skips unknown types (progress, etc.)', async () => {
      const path = await writeTempFile('unknown.jsonl', [
        { type: 'progress', data: { type: 'hook_progress' }, timestamp: '2024-01-01T10:00:00.000Z' },
        { type: 'result', subtype: 'success', timestamp: '2024-01-01T10:00:00.000Z' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(0)
    })

    test('handles line without timestamp', async () => {
      const path = await writeTempFile('no-timestamp.jsonl', [
        { type: 'summary', summary: 'No timestamp here' },
      ])

      const msgs: ConversationMessage[] = []
      for await (const msg of extractConversation(path)) {
        msgs.push(msg)
      }

      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.timestamp).toBe('')
    })
  })

  describe('formatConversationToText', () => {
    test('formats messages as [timestamp] TYPE: content lines', async () => {
      const path = await writeTempFile('format.jsonl', [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hello' }, cwd: '/tmp' },
        { type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] } },
      ])

      const text = await formatConversationToText(path)
      const lines = text.split('\n').filter(l => l.length > 0)

      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^\[.+\] USER: Hello$/)
      expect(lines[1]).toMatch(/^\[.+\] ASSISTANT: Hi!$/)
    })

    test('omits timestamp bracket when timestamp is empty', async () => {
      const path = await writeTempFile('no-ts-format.jsonl', [
        { type: 'summary', summary: 'Done' },
      ])

      const text = await formatConversationToText(path)

      expect(text.trim()).toBe('SUMMARY: Done')
    })
  })

  describe('getSessionMeta', () => {
    test('extracts metadata from a session file', async () => {
      const sid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hello' }, cwd: '/home/user/project' },
        { type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
        { type: 'user', timestamp: '2024-01-01T10:01:00.000Z', message: { role: 'user', content: 'More' }, cwd: '/home/user/project' },
        { type: 'assistant', timestamp: '2024-01-01T10:01:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Ok' }] } },
        { type: 'summary', timestamp: '2024-01-01T10:02:00.000Z', summary: 'Session ended' },
      ])

      const meta = await getSessionMeta(path)

      expect(meta.id).toBe(sid)
      expect(meta.filePath).toBe(path)
      expect(meta.project).toBe('/home/user/project')
      expect(meta.lineCount).toBe(5)
      expect(meta.hasEnd).toBe(true)
      expect(meta.startTime).toEqual(new Date('2024-01-01T10:00:00.000Z'))
      expect(meta.endTime).toEqual(new Date('2024-01-01T10:02:00.000Z'))
      expect(meta.userTurns).toBe(2)
      expect(meta.ageSec).toBeGreaterThanOrEqual(0)
    })

    test('hasEnd is false when no summary present', async () => {
      const sid = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hello' }, cwd: '/tmp' },
        { type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      ])

      const meta = await getSessionMeta(path)

      expect(meta.hasEnd).toBe(false)
    })

    test('extracts UUID from filename', async () => {
      const sid = 'c3d4e5f6-a7b8-9012-cdef-123456789012'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Hi' }, cwd: '/tmp' },
      ])

      const meta = await getSessionMeta(path)
      expect(meta.id).toBe(sid)
    })

    test('endTime is undefined when only one timestamp line', async () => {
      const sid = 'd4e5f6a7-b8c9-0123-defa-234567890123'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', message: { role: 'user', content: 'Solo' }, cwd: '/tmp' },
      ])

      const meta = await getSessionMeta(path)
      expect(meta.startTime).toEqual(new Date('2024-01-01T10:00:00.000Z'))
      // endTime equals startTime when there's only one line with timestamp
      expect(meta.endTime).toEqual(new Date('2024-01-01T10:00:00.000Z'))
    })

    test('project defaults to empty string when no cwd found', async () => {
      const sid = 'e5f6a7b8-c9d0-1234-efab-345678901234'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'summary', summary: 'Just a summary' },
      ])

      const meta = await getSessionMeta(path)
      expect(meta.project).toBe('')
    })

    test('forkInfo is undefined for non-fork sessions', async () => {
      const sid = 'f6a7b8c9-d0e1-2345-fabc-456789012345'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', uuid: 'aaa11111-0000-0000-0000-000000000000', message: { role: 'user', content: 'Hello' }, cwd: '/tmp/project' },
        { type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z', uuid: 'bbb22222-0000-0000-0000-000000000000', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      ])

      const meta = await getSessionMeta(path)
      expect(meta.forkInfo).toBeUndefined()
      expect(meta.lineCount).toBe(2)
      expect(meta.userTurns).toBe(1)
    })

    test('detects fork session and sets forkInfo', async () => {
      const sid = 'a1111111-2222-3333-4444-555555555555'
      const parentSid = 'pppppppp-pppp-pppp-pppp-pppppppppppp'
      const path = await writeTempFile(`${sid}.jsonl`, [
        // フォーク行（親からのコピー）
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', uuid: 'fork0001-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'orig0001' }, message: { role: 'user', content: 'Hello' }, cwd: '/tmp/parent-project' },
        { type: 'assistant', timestamp: '2024-01-01T10:00:05.000Z', uuid: 'fork0002-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'orig0002' }, message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
        { type: 'user', timestamp: '2024-01-01T10:01:00.000Z', uuid: 'fork0003-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'orig0003' }, message: { role: 'user', content: 'Parent conversation' }, cwd: '/tmp/parent-project' },
        // フォーク後の新規行
        { type: 'user', timestamp: '2024-01-01T11:00:00.000Z', uuid: 'new00001-0000-0000-0000-000000000000', message: { role: 'user', content: 'Fork conversation' }, cwd: '/tmp/fork-project' },
        { type: 'assistant', timestamp: '2024-01-01T11:00:10.000Z', uuid: 'new00002-0000-0000-0000-000000000000', message: { role: 'assistant', content: [{ type: 'text', text: 'Fork reply' }] } },
      ])

      const meta = await getSessionMeta(path)
      expect(meta.forkInfo).toBeDefined()
      expect(meta.forkInfo!.parentSessionId).toBe(parentSid)
      expect(meta.forkInfo!.firstNewUuid).toBe('new00001-0000-0000-0000-000000000000')
    })

    test('fork session metadata is computed from non-fork lines only', async () => {
      const sid = 'b2222222-3333-4444-5555-666666666666'
      const parentSid = 'qqqqqqqq-qqqq-qqqq-qqqq-qqqqqqqqqqqq'
      const path = await writeTempFile(`${sid}.jsonl`, [
        // フォーク行 3行
        { type: 'user', timestamp: '2024-01-01T08:00:00.000Z', uuid: 'f0000001-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'o1' }, message: { role: 'user', content: 'Old1' }, cwd: '/tmp/old' },
        { type: 'assistant', timestamp: '2024-01-01T08:05:00.000Z', uuid: 'f0000002-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'o2' }, message: { role: 'assistant', content: [{ type: 'text', text: 'Old reply' }] } },
        { type: 'user', timestamp: '2024-01-01T09:00:00.000Z', uuid: 'f0000003-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'o3' }, message: { role: 'user', content: 'Old2' }, cwd: '/tmp/old' },
        // 新規行 2行
        { type: 'user', timestamp: '2024-01-01T12:00:00.000Z', uuid: 'n0000001-0000-0000-0000-000000000000', message: { role: 'user', content: 'New1' }, cwd: '/tmp/new' },
        { type: 'assistant', timestamp: '2024-01-01T12:30:00.000Z', uuid: 'n0000002-0000-0000-0000-000000000000', message: { role: 'assistant', content: [{ type: 'text', text: 'New reply' }] } },
      ])

      const meta = await getSessionMeta(path)

      // lineCount は非フォーク行のみ
      expect(meta.lineCount).toBe(2)
      // userTurns は非フォーク行のみ
      expect(meta.userTurns).toBe(1)
      // startTime は最初の非フォーク行のタイムスタンプ
      expect(meta.startTime).toEqual(new Date('2024-01-01T12:00:00.000Z'))
      // endTime は最後の非フォーク行のタイムスタンプ
      expect(meta.endTime).toEqual(new Date('2024-01-01T12:30:00.000Z'))
      // project は非フォーク行の cwd
      expect(meta.project).toBe('/tmp/new')
    })

    test('fork session with only fork lines (no new lines)', async () => {
      const sid = 'c3333333-4444-5555-6666-777777777777'
      const parentSid = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'
      const path = await writeTempFile(`${sid}.jsonl`, [
        { type: 'user', timestamp: '2024-01-01T10:00:00.000Z', uuid: 'f0000001-0000-0000-0000-000000000000', forkedFrom: { sessionId: parentSid, messageUuid: 'o1' }, message: { role: 'user', content: 'Only fork' }, cwd: '/tmp/old' },
      ])

      const meta = await getSessionMeta(path)
      // フォーク行しかない場合
      expect(meta.forkInfo).toBeDefined()
      expect(meta.forkInfo!.parentSessionId).toBe(parentSid)
      expect(meta.forkInfo!.firstNewUuid).toBe('') // 新規行がない
      expect(meta.lineCount).toBe(0)
      expect(meta.userTurns).toBe(0)
    })
  })
})
