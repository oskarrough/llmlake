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
  const rows = (await parseSessionText(text, hermesCtx())).filter(
    (r) => r.event_type === 'tool_result',
  )

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

function claudeCtx(sourceFile = 'claude/session.jsonl') {
  return makeParseContext('claude', sourceFile, '/sessions', new Map())
}

test('claude text+tool_use: parent keeps message and usage, call is a suffixed split that pairs', async () => {
  const text = jsonl([
    {
      type: 'assistant',
      uuid: 'a1',
      sessionId: 's1',
      timestamp: '2026-05-10T10:00:00Z',
      message: {
        role: 'assistant',
        model: 'm',
        content: [
          { type: 'text', text: 'Now run the tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'bun test' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'user',
      uuid: 'u1',
      sessionId: 's1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    },
  ])
  const rows = await parseSessionText(text, claudeCtx())

  const msg = rows.find((r) => r.event_type === 'assistant_message')!
  const call = rows.find((r) => r.event_type === 'tool_call')!
  const result = rows.find((r) => r.event_type === 'tool_result')!
  expect(msg.text).toBe('Now run the tests.')
  expect(msg.tool_call_id).toBeNull()
  expect(msg.input_tokens).toBe(10)
  expect(call.input_tokens).toBeNull()
  expect(call.row_id).toBe(`${msg.row_id}-tc0`)
  expect(call.event_id).toBe('a1-tc0')
  expect(call.tool_call_id).toBe('t1')
  expect(call.tool_name).toBe('Bash')
  expect(result.tool_call_id).toBe('t1')
})

test('claude parallel tool_use blocks: every call emitted with unique deterministic ids', async () => {
  const text = jsonl([
    {
      type: 'assistant',
      uuid: 'a2',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Two things.' },
          { type: 'tool_use', id: 't1', name: 'A', input: {} },
          { type: 'tool_use', id: 't2', name: 'B', input: {} },
        ],
      },
    },
  ])
  const rows = await parseSessionText(text, claudeCtx())
  const calls = rows.filter((r) => r.event_type === 'tool_call')

  expect(calls.map((r) => r.tool_call_id)).toEqual(['t1', 't2'])
  expect(calls.map((r) => r.row_id)).toEqual([`${rows[0]!.row_id}-tc0`, `${rows[0]!.row_id}-tc1`])
  expect(new Set(calls.map((r) => r.event_id)).size).toBe(2)
})

test('claude calls-only assistant: base row is the tool_call and keeps usage', async () => {
  const text = jsonl([
    {
      type: 'assistant',
      uuid: 'a3',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    },
  ])
  const rows = await parseSessionText(text, claudeCtx())

  expect(rows).toHaveLength(1)
  expect(rows[0]!.event_type).toBe('tool_call')
  expect(rows[0]!.tool_call_id).toBe('t1')
  expect(rows[0]!.input_tokens).toBe(7)
  expect(rows[0]!.row_id).not.toMatch(/-tc/)
})

test('claude thinking+tool_use: reasoning row plus suffixed tool_call split', async () => {
  const text = jsonl([
    {
      type: 'assistant',
      uuid: 'a4',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ],
      },
    },
  ])
  const rows = await parseSessionText(text, claudeCtx())

  expect(rows.map((r) => r.event_type)).toEqual(['reasoning', 'tool_call'])
  expect(rows[0]!.tool_call_id).toBeNull()
  expect(rows[1]!.row_id).toBe(`${rows[0]!.row_id}-tc0`)
  expect(rows[1]!.tool_call_id).toBe('t1')
})

test('claude workflow journal: session/parent ids from path, session_meta, is_subagent', async () => {
  const text = jsonl([
    { type: 'started', key: 'v2:abc', agentId: 'ag1' },
    { type: 'result', key: 'v2:abc', agentId: 'ag1', result: { ok: true } },
  ])
  const rows = await parseSessionText(
    text,
    claudeCtx(
      'claude/proj/9feac40f-4eaf-4794-a2a2-b46ed016d92a/subagents/workflows/wf_aa2f6efd-665/journal.jsonl',
    ),
  )

  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row.event_type).toBe('session_meta')
    expect(row.session_id).toBe('9feac40f-4eaf-4794-a2a2-b46ed016d92a:wf_aa2f6efd-665')
    expect(row.parent_session_id).toBe('9feac40f-4eaf-4794-a2a2-b46ed016d92a')
    expect(row.is_subagent).toBe(true)
  }
  expect(new Set(rows.map((r) => r.row_id)).size).toBe(2)
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
