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
