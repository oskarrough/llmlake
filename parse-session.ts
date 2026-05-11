// Parse one JSONL line from a raw agent session (claude, pi, codex) into a
// normalized Row in the llmlake schema. The driver supplies a ParseContext
// (agent, source file path, mutable state carried across lines).
import { basename } from 'node:path'
import { computeClaudeCost, computeCodexCost } from './pricing.ts'

export const AGENTS = ['claude', 'pi', 'codex'] as const
export type Agent = (typeof AGENTS)[number]

// DuckDB column types for read_json. Keep in sync with the Row type.
export const COLUMNS = {
  row_id: 'VARCHAR',
  ts: 'TIMESTAMPTZ',
  agent: 'VARCHAR',
  session_id: 'VARCHAR',
  event_id: 'VARCHAR',
  parent_id: 'VARCHAR',
  event_type: 'VARCHAR',
  role: 'VARCHAR',
  model: 'VARCHAR',
  provider: 'VARCHAR',
  input_tokens: 'BIGINT',
  output_tokens: 'BIGINT',
  cache_read_tokens: 'BIGINT',
  cache_write_tokens: 'BIGINT',
  cost_usd: 'DOUBLE',
  text: 'VARCHAR',
  tool_name: 'VARCHAR',
  tool_call_id: 'VARCHAR',
  tool_input: 'JSON',
  tool_output: 'JSON',
  stop_reason: 'VARCHAR',
  cwd: 'VARCHAR',
  is_subagent: 'BOOLEAN',
  source_file: 'VARCHAR',
  source_line: 'BIGINT',
  raw: 'JSON',
} as const

export const colsSql = Object.entries(COLUMNS)
  .map(([k, v]) => `${k}: '${v}'`)
  .join(', ')

export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'session_meta'
  | 'usage'
  | 'compacted'
  | 'other'

export type Row = {
  row_id: string
  ts: string | null
  agent: Agent
  session_id: string | null
  event_id: string | null
  parent_id: string | null
  event_type: EventType
  role: string | null
  model: string | null
  provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cost_usd: number | null
  text: string | null
  tool_name: string | null
  tool_call_id: string | null
  tool_input: unknown
  tool_output: unknown
  stop_reason: string | null
  cwd: string | null
  is_subagent: boolean
  source_file: string
  source_line: number
  raw: unknown
}

export type ParseState = {
  session_id: string | null
  cwd: string | null
  model: string | null
  provider: string | null
  is_subagent: boolean
  seenEventIds: Set<string>
}

export type ParseContext = {
  agent: Agent
  sourceFile: string
  state: ParseState
}

export function newState(): ParseState {
  return {
    session_id: null,
    cwd: null,
    model: null,
    provider: null,
    is_subagent: false,
    seenEventIds: new Set(),
  }
}

function maybeJson(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'string' && /^[[{]/.test(value.trim())) {
    try {
      return JSON.parse(value)
    } catch {}
  }
  return value
}

function normalizeRole(role: unknown): string | null {
  if (role === 'toolResult' || role === 'tool') return 'tool'
  if (role === 'developer') return 'system'
  return typeof role === 'string' ? role : null
}

function contentText(content: unknown): { text: string | null; hasThinking: boolean } {
  if (typeof content === 'string') return { text: content, hasThinking: false }
  if (!Array.isArray(content)) return { text: null, hasThinking: false }
  const texts: string[] = []
  let hasThinking = false
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      texts.push(block.thinking)
      hasThinking = true
    }
  }
  return { text: texts.length ? texts.join('\n') : null, hasThinking }
}

function baseRow(ev: unknown, lineNo: number, ctx: ParseContext): Row {
  return {
    row_id: Bun.hash(`${ctx.sourceFile}:${lineNo}`).toString(16),
    ts: null,
    agent: ctx.agent,
    session_id: ctx.state.session_id,
    event_id: null,
    parent_id: null,
    event_type: 'other',
    role: null,
    model: ctx.state.model,
    provider: ctx.state.provider,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    text: null,
    tool_name: null,
    tool_call_id: null,
    tool_input: null,
    tool_output: null,
    stop_reason: null,
    cwd: ctx.state.cwd,
    is_subagent: ctx.state.is_subagent,
    source_file: ctx.sourceFile,
    source_line: lineNo,
    raw: ev,
  }
}

const CLAUDE_META_TYPES = new Set([
  'attachment',
  'system',
  'permission-mode',
  'last-prompt',
  'file-history-snapshot',
  'progress',
  'agent-setting',
  'ai-title',
  'queue-operation',
  'agent-name',
  'custom-title',
])

function parseClaude(line: string, lineNo: number, ctx: ParseContext): Row | Row[] {
  const { state } = ctx
  const ev = JSON.parse(line)
  const msg = ev.message ?? {}
  const usage = msg.usage ?? {}
  const content = msg.content

  // Claude sometimes appends a subagent event twice to a subagent JSONL
  // (same uuid, byte-identical line). Drop the second copy so per-session
  // token/cost totals aren't inflated.
  if (typeof ev.uuid === 'string') {
    if (state.seenEventIds.has(ev.uuid)) return []
    state.seenEventIds.add(ev.uuid)
  }

  // Fallback: pull session_id from filename when the first event is housekeeping
  // (file-history-snapshot, permission-mode, etc.) and has no sessionId field.
  if (state.session_id == null) {
    const m = basename(ctx.sourceFile).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    )
    state.session_id = m?.[1] ?? null
  }

  if (ev.sessionId) state.session_id = ev.sessionId
  if (ev.cwd) state.cwd = ev.cwd
  if (msg.model) state.model = msg.model

  const row = baseRow(ev, lineNo, ctx)
  row.ts = ev.timestamp ?? null
  row.session_id = ev.sessionId ?? state.session_id
  row.event_id = ev.uuid ?? null
  row.parent_id = ev.parentUuid ?? null
  row.role = normalizeRole(msg.role)
  row.model = msg.model ?? state.model
  row.input_tokens = usage.input_tokens ?? null
  row.output_tokens = usage.output_tokens ?? null
  row.cache_read_tokens = usage.cache_read_input_tokens ?? null
  row.cache_write_tokens = usage.cache_creation_input_tokens ?? null
  row.stop_reason = msg.stop_reason ?? null
  row.cwd = ev.cwd ?? state.cwd
  // Claude's raw flag is `isSidechain`; we surface it under the unified
  // `is_subagent` name. Subagent rows can be interleaved with main-thread
  // rows inside the same file.
  row.is_subagent = ev.isSidechain === true

  if (ev.type === 'user') row.event_type = 'user_message'
  else if (ev.type === 'assistant') row.event_type = 'assistant_message'
  else if (CLAUDE_META_TYPES.has(ev.type)) row.event_type = 'session_meta'

  if (typeof content === 'string') {
    row.text = content
  } else if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        texts.push(block.thinking)
        row.event_type = 'reasoning'
      } else if (block?.type === 'tool_use') {
        row.tool_name ??= block.name ?? null
        row.tool_call_id ??= block.id ?? null
        row.tool_input ??= maybeJson(block.input)
      } else if (block?.type === 'tool_result') {
        row.tool_call_id ??= block.tool_use_id ?? null
        row.tool_output ??= maybeJson(block.content)
        row.event_type = 'tool_result'
      }
    }
    if (texts.length) row.text = texts.join('\n')
  }

  if (row.tool_output == null && ev.toolUseResult != null) {
    row.tool_output = maybeJson(ev.toolUseResult)
    row.event_type = 'tool_result'
  }

  // Pure tool-call turns become tool_call; turns with text keep assistant_message/reasoning
  // so role-based queries still see the message.
  if (row.event_type === 'assistant_message' && row.tool_name && !row.text) {
    row.event_type = 'tool_call'
  }

  row.cost_usd = computeClaudeCost(row.model, row)

  // If a 'reasoning' turn also carries a tool_use, emit a separate tool_call row
  // so the result has a matching call. (Claude messages hold 0 or 1 tool_use blocks.)
  if (row.event_type === 'reasoning' && row.tool_call_id) {
    const sub = baseRow(ev, lineNo, ctx)
    sub.row_id = `${row.row_id}-tc`
    sub.ts = row.ts
    sub.session_id = row.session_id
    sub.event_id = row.event_id ? `${row.event_id}-tc` : null
    sub.parent_id = row.event_id ?? row.parent_id
    sub.role = row.role
    sub.model = row.model
    sub.provider = row.provider
    sub.cwd = row.cwd
    sub.is_subagent = row.is_subagent
    sub.event_type = 'tool_call'
    sub.tool_name = row.tool_name
    sub.tool_call_id = row.tool_call_id
    sub.tool_input = row.tool_input
    row.tool_name = null
    row.tool_call_id = null
    row.tool_input = null
    return [row, sub]
  }
  return row
}

function parsePi(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const { state } = ctx
  const ev = JSON.parse(line)
  const msg = ev.message ?? {}
  const usage = msg.usage ?? {}
  const content = msg.content

  if (ev.type === 'session') {
    state.session_id = ev.id ?? state.session_id
    state.cwd = ev.cwd ?? state.cwd
  }
  if (ev.type === 'model_change') {
    state.provider = ev.provider ?? state.provider
    state.model = ev.modelId ?? ev.model ?? state.model
  }
  if (msg.provider) state.provider = msg.provider
  if (msg.model) state.model = msg.model

  const { text, hasThinking } = contentText(content)
  const role = normalizeRole(msg.role)
  const row = baseRow(ev, lineNo, ctx)

  row.ts =
    ev.timestamp ??
    (typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString() : null)
  row.session_id = state.session_id ?? ev.sessionId ?? null
  row.event_id = ev.id ?? msg.id ?? null
  row.parent_id = ev.parentId ?? null
  row.role = role
  row.model = msg.model ?? ev.modelId ?? state.model
  row.provider = msg.provider ?? ev.provider ?? state.provider
  row.input_tokens = usage.input ?? usage.input_tokens ?? null
  row.output_tokens = usage.output ?? usage.output_tokens ?? null
  row.cache_read_tokens = usage.cacheRead ?? usage.cache_read_tokens ?? null
  row.cache_write_tokens = usage.cacheWrite ?? usage.cache_write_tokens ?? null
  row.cost_usd = typeof usage.cost === 'number' ? usage.cost : (usage.cost?.total ?? null)
  row.text = text
  row.stop_reason = msg.stopReason ?? msg.stop_reason ?? null
  row.cwd = ev.cwd ?? state.cwd

  if (ev.type === 'session' || ev.type === 'model_change' || ev.type === 'thinking_level_change') {
    row.event_type = 'session_meta'
  } else if (ev.type === 'message') {
    if (role === 'user') row.event_type = 'user_message'
    else if (role === 'assistant') row.event_type = hasThinking ? 'reasoning' : 'assistant_message'
    else if (role === 'tool') row.event_type = 'tool_result'
  }

  if (role === 'tool') {
    row.tool_call_id = msg.toolCallId ?? row.tool_call_id
    row.tool_name = msg.toolName ?? row.tool_name
    row.tool_output = maybeJson(content)
    row.event_type = 'tool_result'
  }

  // Assistant turns can contain multiple toolCall blocks. Emit one tool_call row per block
  // and keep the parent row (carrying tokens + thinking/text) only if there's something to keep.
  const toolCalls: { name: string | null; id: string | null; input: unknown }[] = []
  if (role === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'toolCall') {
        toolCalls.push({
          name: block.name ?? null,
          id: block.id ?? null,
          input: maybeJson(block.arguments),
        })
      }
    }
  }

  if (toolCalls.length === 0) return [row]

  const rows: Row[] = []
  // Keep the parent row only when it has content of its own (text or thinking).
  // If the assistant turn is tool-calls-only, the first tool_call carries the tokens.
  const keepParent = !!text || hasThinking
  if (keepParent) rows.push(row)

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!
    const sub = baseRow(ev, lineNo, ctx)
    sub.row_id = `${row.row_id}-${i}`
    sub.ts = row.ts
    sub.session_id = row.session_id
    sub.event_id = row.event_id ? `${row.event_id}-${i}` : null
    sub.parent_id = row.event_id ?? row.parent_id
    sub.role = role
    sub.model = row.model
    sub.provider = row.provider
    sub.cwd = row.cwd
    sub.event_type = 'tool_call'
    sub.tool_name = tc.name
    sub.tool_call_id = tc.id
    sub.tool_input = tc.input
    // Tokens belong to the message, not each block. Put them on the first emitted row
    // when there's no parent row to carry them.
    if (!keepParent && i === 0) {
      sub.input_tokens = row.input_tokens
      sub.output_tokens = row.output_tokens
      sub.cache_read_tokens = row.cache_read_tokens
      sub.cache_write_tokens = row.cache_write_tokens
      sub.cost_usd = row.cost_usd
      sub.stop_reason = row.stop_reason
    }
    rows.push(sub)
  }
  return rows
}

function parseCodex(line: string, lineNo: number, ctx: ParseContext): Row {
  const { state } = ctx
  const ev = JSON.parse(line)
  const p = ev.payload ?? {}

  if (state.session_id == null) {
    const m = basename(ctx.sourceFile).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    )
    state.session_id = m?.[1] ?? null
  }

  if (ev.type === 'session_meta') {
    if (p.id) state.session_id = p.id
    if (p.cwd) state.cwd = p.cwd
    if (p.model_provider) state.provider = p.model_provider
    // Codex spawns subagent threads as separate sessions. session_meta carries
    // source.subagent (and a forked_from_id) on spawned threads; apply that
    // flag to every row in the file.
    if (p.source?.subagent != null || p.forked_from_id != null) {
      state.is_subagent = true
    }
  } else if (ev.type === 'turn_context') {
    if (p.cwd) state.cwd = p.cwd
    if (p.model) state.model = p.model
  }

  const row = baseRow(ev, lineNo, ctx)
  row.ts = ev.timestamp ?? null

  if (ev.type === 'session_meta' || ev.type === 'turn_context') {
    row.event_type = 'session_meta'
  } else if (ev.type === 'compacted') {
    row.event_type = 'compacted'
    if (typeof p.message === 'string') row.text = p.message
  } else if (ev.type === 'event_msg') {
    row.event_type = 'usage'
    const last = p.info?.last_token_usage
    if (last) {
      row.input_tokens = last.input_tokens ?? null
      row.output_tokens = last.output_tokens ?? null
      row.cache_read_tokens = last.cached_input_tokens ?? null
    }
  } else if (ev.type === 'response_item') {
    row.role = normalizeRole(p.role)

    if (p.type === 'message') {
      row.event_type = row.role === 'assistant' ? 'assistant_message' : 'user_message'
      if (Array.isArray(p.content)) {
        const texts: string[] = []
        for (const b of p.content) if (typeof b?.text === 'string') texts.push(b.text)
        if (texts.length) row.text = texts.join('\n')
      }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      row.event_type = 'tool_call'
      row.tool_name = p.name ?? null
      row.tool_call_id = p.call_id ?? null
      row.tool_input = maybeJson(p.arguments ?? p.input)
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      row.event_type = 'tool_result'
      row.tool_call_id = p.call_id ?? null
      row.tool_output = maybeJson(p.output)
    } else if (p.type === 'reasoning') {
      row.event_type = 'reasoning'
      const texts: string[] = []
      for (const b of p.summary ?? []) if (typeof b?.text === 'string') texts.push(b.text)
      for (const b of p.content ?? []) if (typeof b?.text === 'string') texts.push(b.text)
      if (texts.length) row.text = texts.join('\n')
    } else if (p.type === 'web_search_call') {
      row.event_type = 'tool_call'
      row.tool_name = 'web_search'
      row.tool_call_id = p.id ?? null
      row.tool_input = maybeJson(p.action ?? p.query ?? null)
    }
  }

  if (row.input_tokens != null || row.output_tokens != null) {
    row.cost_usd = computeCodexCost(row.model, row)
  }
  return row
}

const PARSERS: Record<Agent, (l: string, n: number, c: ParseContext) => Row | Row[]> = {
  claude: parseClaude,
  pi: parsePi,
  codex: parseCodex,
}

export function parseLine(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const result = PARSERS[ctx.agent](line, lineNo, ctx)
  return Array.isArray(result) ? result : [result]
}
