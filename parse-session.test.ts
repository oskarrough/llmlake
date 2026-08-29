import { expect, spyOn, test } from 'bun:test'
import { makeParseContext, parseSessionText, type Agent } from './parse-session.ts'

const cases: { agent: Agent; sourceFile: string; lines: unknown[] }[] = [
  {
    agent: 'claude',
    sourceFile: 'claude/session.jsonl',
    lines: [
      { type: 'user', uuid: 'u1', sessionId: 's1', message: { role: 'user', content: 'before' } },
      { type: 'user', uuid: 'u2', sessionId: 's1', message: { role: 'user', content: 'after' } },
    ],
  },
  {
    agent: 'pi',
    sourceFile: 'pi/session.jsonl',
    lines: [
      { type: 'session', id: 's1' },
      { type: 'message', id: 'm1', message: { role: 'user', content: 'after' } },
    ],
  },
  {
    agent: 'codex',
    sourceFile: 'codex/session.jsonl',
    lines: [
      { type: 'session_meta', payload: { id: 's1' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ text: 'after' }] },
      },
    ],
  },
  {
    agent: 'hermes',
    sourceFile: 'hermes/20260812_120000_abcd.jsonl',
    lines: [
      { role: 'session_meta', model: 'test-model', platform: 'test-provider' },
      { role: 'user', content: 'after' },
    ],
  },
]

function hermesCtx() {
  return makeParseContext('hermes', 'hermes/20260510_095457_3ba7be68.jsonl', '/sessions', new Map())
}

function cursorCtx() {
  return makeParseContext('cursor', 'cursor/composer-1.jsonl', '/sessions', new Map())
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n')

test('hermes assistant fan-out: parent keeps base row_id, calls get indexed suffixes', async () => {
  const text = jsonl([
    { role: 'session_meta', model: 'm', platform: 'p' },
    {
      role: 'assistant',
      timestamp: '2026-05-10T09:55:00.100200',
      content: 'doing things',
      tool_calls: [
        { id: 'tc1', function: { name: 'a', arguments: '{}' } },
        { id: 'tc2', function: { name: 'b', arguments: '{}' } },
      ],
    },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'tc3', function: { name: 'a', arguments: '{}' } },
        { id: 'tc4', function: { name: 'b', arguments: '{}' } },
      ],
    },
  ])
  const rows = await parseSessionText(text, hermesCtx())

  // With-content line fans out to parent + calls; content-less line to calls only.
  expect(rows.map((r) => r.event_type)).toEqual([
    'assistant_message',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_call',
  ])
  expect(new Set(rows.map((r) => r.row_id)).size).toBe(5)
  // Parent keeps the base hash; calls are deterministically suffixed by index.
  expect(rows[1]!.row_id).toBe(`${rows[0]!.row_id}-0`)
  expect(rows[2]!.row_id).toBe(`${rows[0]!.row_id}-1`)
  expect(rows[3]!.row_id.endsWith('-0')).toBe(true)
  expect(rows[4]!.row_id.endsWith('-1')).toBe(true)
  // tool_call_id pairing unchanged (parent itself carries none)
  expect(rows.map((r) => r.tool_call_id)).toEqual([null, 'tc1', 'tc2', 'tc3', 'tc4'])
})

test('hermes tool_result event_id is suffixed, tool_call_id pairing unchanged', async () => {
  const text = jsonl([
    { role: 'session_meta', model: 'm', platform: 'p' },
    { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'a', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', name: 'a', content: 'ok' },
  ])
  const rows = await parseSessionText(text, hermesCtx())
  const call = rows.find((r) => r.event_type === 'tool_call')!
  const result = rows.find((r) => r.event_type === 'tool_result')!

  expect(call.event_id).toBe('tc1')
  expect(result.event_id).toBe('tc1:result')
  expect(result.tool_call_id).toBe('tc1')
})

test('hermes is_error derives from structured content, not forced false', async () => {
  const mk = (content: unknown) => ({ role: 'tool', tool_call_id: 't', name: 'n', content })
  const text = jsonl([
    { role: 'session_meta', model: 'm', platform: 'p' },
    mk(JSON.stringify({ output: 'boom', exit_code: 2, error: null })),
    mk(JSON.stringify({ output: '', exit_code: 0, error: null })),
    mk(JSON.stringify({ output: 'warned', exit_code: 0, error: 0 })),
    mk(JSON.stringify({ success: false, error: 'nope' })),
    mk(JSON.stringify({ success: true })),
    mk('plain text, not json'),
  ])
  const rows = (await parseSessionText(text, hermesCtx())).filter((r) => r.event_type === 'tool_result')

  expect(rows.map((r) => r.is_error)).toEqual([true, false, false, true, false, false])
})

test('hermes naive timestamp keeps local wall clock with an appended offset (incl. tool_result)', async () => {
  const naive = '2026-05-10T09:54:57.709482'
  const text = jsonl([
    { role: 'session_meta', model: 'm', platform: 'p' },
    { role: 'user', timestamp: naive, content: 'hi' },
    { role: 'tool', tool_call_id: 't1', name: 'n', timestamp: naive, content: 'ok' },
  ])
  const rows = await parseSessionText(text, hermesCtx())

  for (const row of rows) {
    const ts = row.ts!
    // Raw string preserved verbatim, exactly one UTC offset appended.
    expect(ts).toMatch(/^2026-05-10T09:54:57\.709482[+-]\d{2}:\d{2}$/)
    // The appended offset yields the correct local instant for the wall-clock components.
    expect(Date.parse(ts)).toBe(new Date(2026, 4, 10, 9, 54, 57, 709).getTime())
  }
  // The regression must cover the tool_result branch, not just user/assistant rows.
  expect(rows.find((r) => r.event_type === 'tool_result')).toBeDefined()
})

test('cursor tool bubble: result row_id suffixed, event_ids unique, pairing unchanged', async () => {
  const text = jsonl([
    { role: 'session_meta', composerId: 'comp1', cwd: '/x', model: 'm' },
    {
      role: 'assistant',
      bubbleId: 'b1',
      ts: '2026-05-10T10:00:00Z',
      tool: { callId: 'call_1', name: 'read', args: {}, result: 'data', isError: true },
    },
  ])
  const rows = await parseSessionText(text, cursorCtx())
  const call = rows.find((r) => r.event_type === 'tool_call')!
  const result = rows.find((r) => r.event_type === 'tool_result')!

  expect(call.row_id).not.toBe(result.row_id)
  expect(result.row_id).toBe(`${call.row_id}-result`)
  expect(call.event_id).toBe('call_1')
  expect(result.event_id).toBe('call_1:result')
  expect(call.tool_call_id).toBe('call_1')
  expect(result.tool_call_id).toBe('call_1')
  expect(result.is_error).toBe(true)
})

for (const { agent, sourceFile, lines } of cases) {
  test(`${agent} skips malformed JSON and continues parsing the session`, async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const text = `${JSON.stringify(lines[0])}\n{"broken":\n${JSON.stringify(lines[1])}\n`
      const ctx = makeParseContext(agent, sourceFile, '/sessions', new Map())

      const rows = await parseSessionText(text, ctx)

      expect(rows.some((row) => row.source_line === 3)).toBe(true)
      expect(warn).toHaveBeenCalledWith(
        `dropped truncated line 2 in ${sourceFile} (1 line skipped, rest of session built)`,
      )
    } finally {
      warn.mockRestore()
    }
  })
}
