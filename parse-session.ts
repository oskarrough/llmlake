// Parse one JSONL line from a raw agent session (claude, pi, codex, hermes)
// into a normalized Row in the llmlake schema. The driver supplies a
// ParseContext (agent, source file path, mutable state carried across lines).
import { basename } from 'node:path'
import { Option, Schema, SchemaAST } from 'effect'
import { computeClaudeCost, computeCodexCost } from './pricing.ts'

// Single source of truth for both the TypeScript `Row` type and the DuckDB
// column-type map fed to read_json. Each field carries a duckdb annotation so
// `COLUMNS` / `colsSql` are derived from the schema instead of maintained as
// a parallel const.

const DuckdbTypeId = Symbol.for('llmlake/DuckdbType')

const duckdb =
  (type: string) =>
  <S extends Schema.Schema.Any>(schema: S): S =>
    schema.annotations({ [DuckdbTypeId]: type }) as S

const STR = Schema.NullOr(Schema.String).pipe(duckdb('VARCHAR'))
const INT = Schema.NullOr(Schema.Number).pipe(duckdb('BIGINT'))
const DBL = Schema.NullOr(Schema.Number).pipe(duckdb('DOUBLE'))
const BOOL = Schema.NullOr(Schema.Boolean).pipe(duckdb('BOOLEAN'))
const JSON_ = Schema.Unknown.pipe(duckdb('JSON'))

export const AGENTS = ['claude', 'pi', 'codex', 'hermes'] as const
const AgentSchema = Schema.Literal(...AGENTS).pipe(duckdb('VARCHAR'))
export type Agent = (typeof AGENTS)[number]

const EVENT_TYPES = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'reasoning',
  'session_meta',
  'usage',
  'compacted',
  'other',
] as const
const EventTypeSchema = Schema.Literal(...EVENT_TYPES).pipe(duckdb('VARCHAR'))
export type EventType = (typeof EVENT_TYPES)[number]

export const RowSchema = Schema.Struct({
  row_id: Schema.String.pipe(duckdb('VARCHAR')),
  ts: Schema.NullOr(Schema.String).pipe(duckdb('TIMESTAMPTZ')),
  agent: AgentSchema,
  session_id: STR,
  parent_session_id: STR,
  event_id: STR,
  parent_id: STR,
  event_type: EventTypeSchema,
  role: STR,
  model: STR,
  provider: STR,
  input_tokens: INT,
  output_tokens: INT,
  cache_read_tokens: INT,
  cache_write_tokens: INT,
  cost_usd: DBL,
  text: STR,
  tool_name: STR,
  tool_call_id: STR,
  tool_input: JSON_,
  tool_output: JSON_,
  is_error: BOOL,
  stop_reason: STR,
  cwd: STR,
  is_subagent: Schema.Boolean.pipe(duckdb('BOOLEAN')),
  source_file: Schema.String.pipe(duckdb('VARCHAR')),
  source_line: Schema.Number.pipe(duckdb('BIGINT')),
  raw: JSON_,
})

// Schema.Struct fields are readonly in the inferred type, but the parsers
// build a row by mutating fields after `baseRow`. Strip readonly here so the
// working type lines up with the imperative parser style.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
export type Row = Mutable<Schema.Schema.Type<typeof RowSchema>>

// Walk the schema once at module load to extract column types — fails fast if
// a field is missing its duckdb annotation, so the parquet writer is never fed
// a row whose column type is unknown to DuckDB.
const rowAst = RowSchema.ast
if (rowAst._tag !== 'TypeLiteral') throw new Error('RowSchema must be a TypeLiteral')
const getDuckdbType = SchemaAST.getAnnotation<string>(DuckdbTypeId)
export const COLUMNS: Readonly<Record<string, string>> = Object.fromEntries(
  rowAst.propertySignatures.map((ps) => {
    const ann = getDuckdbType(ps.type)
    if (Option.isNone(ann)) {
      throw new Error(`row schema field '${String(ps.name)}' missing duckdb annotation`)
    }
    return [String(ps.name), ann.value]
  }),
)

export const colsSql = Object.entries(COLUMNS)
  .map(([k, v]) => `${k}: '${v}'`)
  .join(', ')

export type ParseState = {
  session_id: string | null
  parent_session_id: string | null
  cwd: string | null
  model: string | null
  provider: string | null
  is_subagent: boolean
  // Claude subagents live in `<parent>/subagents/agent-*.jsonl` but their
  // events carry the *parent's* sessionId. We mint a synthetic per-jsonl
  // session_id so each subagent run is its own "session" in analytics.
  // Set to the `agent-<suffix>` token on first row of a subagent file.
  subagent_suffix: string | null
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
    parent_session_id: null,
    cwd: null,
    model: null,
    provider: null,
    is_subagent: false,
    subagent_suffix: null,
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
    parent_session_id: ctx.state.parent_session_id,
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
    is_error: null,
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
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    console.warn(`malformed line ${lineNo} in ${ctx.sourceFile}`)
    return []
  }
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

  // Detect subagent files once per session: `<parent>/subagents/agent-*.jsonl`.
  // We mint a synthetic session_id `<parent>:<agent-suffix>` so each subagent
  // run is its own session in analytics, and keep the real parent sessionId
  // in parent_session_id for rollups.
  if (state.subagent_suffix == null) {
    state.subagent_suffix = ctx.sourceFile.match(/\/subagents\/(agent-[^/]+?)\.jsonl$/)?.[1] ?? null
  }

  const rawSessionId =
    ev.sessionId ??
    state.parent_session_id ??
    (state.subagent_suffix ? null : state.session_id) ??
    basename(ctx.sourceFile).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    )?.[1] ??
    null

  if (state.subagent_suffix) {
    state.parent_session_id = rawSessionId
    state.session_id = rawSessionId
      ? `${rawSessionId}:${state.subagent_suffix}`
      : state.subagent_suffix
  } else {
    state.session_id = rawSessionId
    state.parent_session_id = null
  }

  if (ev.cwd) state.cwd = ev.cwd
  if (msg.model) state.model = msg.model

  const row = baseRow(ev, lineNo, ctx)
  row.ts = ev.timestamp ?? null
  row.session_id = state.session_id
  row.parent_session_id = state.parent_session_id
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
        // Claude omits is_error on success; absent = false.
        row.is_error = block.is_error === true
        row.event_type = 'tool_result'
      }
    }
    if (texts.length) row.text = texts.join('\n')
  }

  if (row.tool_output == null && ev.toolUseResult != null) {
    row.tool_output = maybeJson(ev.toolUseResult)
    row.event_type = 'tool_result'
    if (row.is_error == null) row.is_error = false
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
    if (typeof msg.isError === 'boolean') row.is_error = msg.isError
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
    if (p.forked_from_id) state.parent_session_id = p.forked_from_id
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
      // Codex error signals:
      //  - function_call_output: free-text "Process exited with code N"
      //  - custom_tool_call_output: JSON-wrapped success {output, metadata:{exit_code}};
      //    failures come through as a plain non-JSON string ("apply_patch verification failed: ...").
      if (p.type === 'function_call_output' && typeof p.output === 'string') {
        const m = p.output.match(/Process exited with code (\d+)/)
        if (m) row.is_error = m[1] !== '0'
      } else if (p.type === 'custom_tool_call_output') {
        if (row.tool_output && typeof row.tool_output === 'object') {
          const code = (row.tool_output as { metadata?: { exit_code?: unknown } }).metadata
            ?.exit_code
          row.is_error = typeof code === 'number' ? code !== 0 : false
        } else {
          row.is_error = true
        }
      }
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

function parseHermes(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const { state } = ctx
  const ev = JSON.parse(line)

  // session_meta — extract provider and model, skip row
  if (ev.role === 'session_meta') {
    if (ev.model) state.model = ev.model
    if (ev.platform) state.provider = ev.platform
    return []
  }

  // Derive session_id from filename (YYYYMMDD_HHMMSS_<hash>.jsonl)
  if (state.session_id == null) {
    const m = basename(ctx.sourceFile).match(/^(\d{8}_\d{6})_([0-9a-f]+)\.jsonl/)
    state.session_id = m?.[2] ?? null
  }

  // --- assistant lines: can carry tool_calls[] alongside content/reasoning ---
  if (ev.role === 'assistant') {
    const toolCalls = ev.tool_calls ?? []
    const callRows: Row[] = []

    for (const tc of toolCalls) {
      const fn = tc.function ?? {}
      const cr: Row = baseRow(ev, lineNo, ctx)
      cr.ts = ev.timestamp ?? null
      cr.session_id = state.session_id
      cr.event_id = tc.id ?? tc.call_id ?? null
      cr.event_type = 'tool_call'
      cr.role = 'assistant'
      cr.model = state.model
      cr.provider = state.provider
      cr.cwd = state.cwd
      cr.tool_name = fn.name ?? null
      cr.tool_call_id = tc.id ?? tc.call_id ?? null
      cr.tool_input = maybeJson(fn.arguments ?? null)
      callRows.push(cr)
    }

    // Parent row only if there's content, reasoning, or no tool calls
    const content = typeof ev.content === 'string' ? ev.content : null
    const thinking = typeof ev.reasoning === 'string' ? ev.reasoning : null
    const hasContent = !!(content || thinking)

    if (hasContent) {
      const parent: Row = baseRow(ev, lineNo, ctx)
      parent.ts = ev.timestamp ?? null
      parent.session_id = state.session_id
      parent.event_type = thinking ? 'reasoning' : 'assistant_message'
      parent.role = 'assistant'
      parent.model = state.model
      parent.provider = state.provider
      parent.cwd = state.cwd
      parent.text = thinking || content
      parent.stop_reason = ev.finish_reason ?? null
      return callRows.length ? [parent, ...callRows] : [parent]
    }
    return callRows.length ? callRows : []
  }

  // --- tool result lines ---
  if (ev.role === 'tool') {
    const row: Row = baseRow(ev, lineNo, ctx)
    row.ts = ev.timestamp ?? null
    row.session_id = state.session_id
    row.event_id = ev.tool_call_id ?? null
    row.event_type = 'tool_result'
    row.role = 'tool'
    row.model = state.model
    row.provider = state.provider
    row.cwd = state.cwd
    row.tool_name = ev.name ?? null
    row.tool_call_id = ev.tool_call_id ?? null
    row.tool_output = maybeJson(ev.content)
    // Hermes doesn't ship is_error on tool lines; absent = success
    row.is_error = false
    return [row]
  }

  // --- user lines ---
  const content = typeof ev.content === 'string' ? ev.content : null
  const row = baseRow(ev, lineNo, ctx)
  row.ts = ev.timestamp ?? null
  row.session_id = state.session_id
  row.event_type = 'user_message'
  row.role = 'user'
  row.model = state.model
  row.provider = state.provider
  row.cwd = state.cwd
  row.text = content ?? null
  return [row]
}

const PARSERS: Record<Agent, (l: string, n: number, c: ParseContext) => Row | Row[]> = {
  claude: parseClaude,
  pi: parsePi,
  codex: parseCodex,
  hermes: parseHermes,
}

export function parseLine(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const result = PARSERS[ctx.agent](line, lineNo, ctx)
  return Array.isArray(result) ? result : [result]
}
