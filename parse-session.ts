// Parse one JSONL line from a raw agent session into a normalized Row in the llmlake schema; the driver supplies a ParseContext (agent, source path, mutable state carried across lines).
import { basename, join, relative } from 'node:path'
import { Option, Schema, SchemaAST } from 'effect'
import { computeClaudeCost, computeCodexCost } from './pricing.ts'

// Single source of truth for the `Row` type and the DuckDB column map: each field carries a duckdb annotation so COLUMNS/colsSql derive from the schema.

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
const STR_REQ = Schema.String.pipe(duckdb('VARCHAR'))
const INT_REQ = Schema.Number.pipe(duckdb('BIGINT'))
const BOOL_REQ = Schema.Boolean.pipe(duckdb('BOOLEAN'))

export const AGENTS = ['claude', 'pi', 'codex', 'hermes', 'cursor'] as const
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
  row_id: STR_REQ,
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
  is_subagent: BOOL_REQ,
  source_file: STR_REQ,
  source_line: INT_REQ,
  raw: JSON_,
})

// Schema.Struct infers readonly fields but parsers mutate rows after baseRow; strip readonly to match.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
export type Row = Mutable<Schema.Schema.Type<typeof RowSchema>>

// Walk the schema once at load; fails fast if a field lacks its duckdb annotation.
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

type CodexTotals = { input: number; cached: number; output: number }

const CODEX_ZERO: CodexTotals = { input: 0, cached: 0, output: 0 }

const mapTotals = (
  a: CodexTotals,
  b: CodexTotals,
  f: (x: number, y: number) => number,
): CodexTotals => ({
  input: f(a.input, b.input),
  cached: f(a.cached, b.cached),
  output: f(a.output, b.output),
})

const addTotals = (a: CodexTotals, b: CodexTotals) => mapTotals(a, b, (x, y) => x + y)
// Component-wise max(0, a - b).
const subTotals = (a: CodexTotals, b: CodexTotals) => mapTotals(a, b, (x, y) => Math.max(0, x - y))
const totalsEqual = (a: CodexTotals, b: CodexTotals) =>
  a.input === b.input && a.cached === b.cached && a.output === b.output
const isZero = (t: CodexTotals) => t.input === 0 && t.cached === 0 && t.output === 0

// Mutable cursor carried across a codex file's token_count events (rebuilt standalone for fork parents); lives on ParseState as `codexWalk`.
type CodexTokenWalk = {
  previousTotals: CodexTotals | null
  rawTotalsBaseline: CodexTotals | null
  sawDivergentTotals: boolean
  remainingInherited: CodexTotals | null
  inheritedTotals: CodexTotals | null
}

function newCodexWalk(): CodexTokenWalk {
  return {
    previousTotals: null,
    rawTotalsBaseline: null,
    sawDivergentTotals: false,
    remainingInherited: null,
    inheritedTotals: null,
  }
}

type ClaudeKeyedUsage = {
  lineNo: number
  isSidechain: boolean
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

/** Cross-file winner for (session_id, message.id, requestId) when roots overlap. */
export type ClaudeCrossFileRegistry = {
  winners: Map<string, { sourceFile: string; lineNo: number; isSidechain: boolean }>
}

export function newClaudeCrossFileRegistry(): ClaudeCrossFileRegistry {
  return { winners: new Map() }
}

export type ParseState = {
  session_id: string | null
  parent_session_id: string | null
  cwd: string | null
  model: string | null
  provider: string | null
  is_subagent: boolean
  // Claude subagents live in `<parent>/subagents/agent-*.jsonl` but carry the parent's sessionId; we mint a synthetic `agent-<suffix>` session_id so each subagent run is its own session.
  subagent_suffix: string | null
  seenEventIds: Set<string>
  // Streaming assistant chunks share message.id + requestId; keep last per file.
  claudeKeyedUsage: Map<string, ClaudeKeyedUsage>
  codexWalk: CodexTokenWalk
}

export type ParseContext = {
  agent: Agent
  sourceFile: string
  state: ParseState
  /** Absolute path to data/sessions — used for Codex fork parent lookup. */
  sessionsRoot?: string
  /** session_id → source_file relative to sessionsRoot (codex only). */
  codexSessionIndex?: ReadonlyMap<string, string>
  /** Populated during build pass 1; finalize uses it in pass 2 (claude only). */
  claudeCrossFile?: ClaudeCrossFileRegistry
  /** Suppress per-line warnings (set on the claude cross-file pre-pass). */
  quiet?: boolean
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
    claudeKeyedUsage: new Map(),
    codexWalk: newCodexWalk(),
  }
}

const SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function codexToInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.trunc(v))
  return 0
}

function codexTotalsFromUsage(obj: Record<string, unknown> | undefined): CodexTotals {
  if (!obj) return { input: 0, cached: 0, output: 0 }
  return {
    input: codexToInt(obj.input_tokens),
    cached: codexToInt(obj.cached_input_tokens ?? obj.cache_read_input_tokens),
    output: codexToInt(obj.output_tokens),
  }
}

function codexDivergentTotalDelta(
  rawBaseline: CodexTotals | null,
  countedBaseline: CodexTotals | null,
  current: CodexTotals,
): CodexTotals {
  const raw = rawBaseline ?? { input: 0, cached: 0, output: 0 }
  const counted = countedBaseline ?? { input: 0, cached: 0, output: 0 }
  const delta = (rawVal: number, countedVal: number, cur: number) =>
    cur >= rawVal ? Math.max(0, cur - rawVal) : Math.max(0, cur - countedVal)
  return {
    input: delta(raw.input, counted.input, current.input),
    cached: delta(raw.cached, counted.cached, current.cached),
    output: delta(raw.output, counted.output, current.output),
  }
}

/** Apply one token_count info block; mutates walk and returns delta + cumulative counted totals. */
function advanceCodexTokenCount(
  info: Record<string, unknown>,
  walk: CodexTokenWalk,
): { delta: CodexTotals; countedTotals: CodexTotals } | null {
  const total = info.total_token_usage as Record<string, unknown> | undefined
  const last = info.last_token_usage as Record<string, unknown> | undefined

  if (last) {
    const rawDelta = codexTotalsFromUsage(last)
    let delta = rawDelta
    if (walk.remainingInherited) {
      delta = subTotals(rawDelta, walk.remainingInherited)
      const nextRemaining = subTotals(walk.remainingInherited, rawDelta)
      walk.remainingInherited = isZero(nextRemaining) ? null : nextRemaining
    }
    const countedTotals = addTotals(walk.previousTotals ?? CODEX_ZERO, delta)
    walk.previousTotals = countedTotals
    if (total) {
      let rawTotals = codexTotalsFromUsage(total)
      if (walk.inheritedTotals) rawTotals = subTotals(rawTotals, walk.inheritedTotals)
      walk.rawTotalsBaseline = rawTotals
      if (!totalsEqual(rawTotals, countedTotals)) walk.sawDivergentTotals = true
    } else {
      walk.rawTotalsBaseline = countedTotals
    }
    return { delta, countedTotals }
  }

  if (total) {
    let rawTotals = codexTotalsFromUsage(total)
    if (walk.inheritedTotals) rawTotals = subTotals(rawTotals, walk.inheritedTotals)
    const delta = walk.sawDivergentTotals
      ? codexDivergentTotalDelta(walk.rawTotalsBaseline, walk.previousTotals, rawTotals)
      : subTotals(rawTotals, walk.rawTotalsBaseline ?? CODEX_ZERO)
    const countedTotals = addTotals(walk.previousTotals ?? CODEX_ZERO, delta)
    walk.previousTotals = countedTotals
    walk.rawTotalsBaseline = rawTotals
    if (!totalsEqual(rawTotals, countedTotals)) walk.sawDivergentTotals = true
    walk.remainingInherited = null
    return { delta, countedTotals }
  }

  return null
}

function parseCodexSessionIdFromFile(path: string): string | null {
  return basename(path).match(SESSION_ID_RE)?.[1] ?? null
}

/** Map codex session_id → source_file path relative to data/sessions. */
export async function buildCodexSessionIndex(sessionsRoot: string): Promise<Map<string, string>> {
  const codexRoot = join(sessionsRoot, 'codex')
  const index = new Map<string, string>()
  for await (const abs of new Bun.Glob('**/*.jsonl').scan({
    cwd: codexRoot,
    absolute: true,
    onlyFiles: true,
  })) {
    const rel = abs.slice(sessionsRoot.length + 1).replace(/\\/g, '/')
    const fromName = parseCodexSessionIdFromFile(abs)
    if (fromName) index.set(fromName, rel)
  }
  return index
}

function codexInheritedTotalsFromSnapshots(
  snapshots: { timestamp: string; totals: CodexTotals }[],
  forkTimestamp: string,
): CodexTotals | null {
  if (!forkTimestamp) return null
  const cutoff = Date.parse(forkTimestamp)
  let inherited: CodexTotals | null = null
  for (const snap of snapshots) {
    const at = Date.parse(snap.timestamp)
    const isAtOrBefore =
      !Number.isNaN(cutoff) && !Number.isNaN(at) ? at <= cutoff : snap.timestamp <= forkTimestamp
    if (isAtOrBefore) inherited = snap.totals
  }
  return inherited
}

async function codexInheritedTotalsAtFork(
  parentSourceFile: string,
  forkTimestamp: string,
): Promise<CodexTotals | null> {
  const text = await Bun.file(parentSourceFile).text()
  const walk = newCodexWalk()
  const snapshots: { timestamp: string; totals: CodexTotals }[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const p = ev.payload ?? {}
    if (ev.type !== 'event_msg' || p.type !== 'token_count') continue
    const timestamp = ev.timestamp
    if (typeof timestamp !== 'string') continue
    const result = advanceCodexTokenCount((p.info ?? {}) as Record<string, unknown>, walk)
    if (result) snapshots.push({ timestamp, totals: result.countedTotals })
  }
  return codexInheritedTotalsFromSnapshots(snapshots, forkTimestamp)
}

async function preloadCodexForkInheritance(text: string, ctx: ParseContext): Promise<void> {
  if (ctx.agent !== 'codex' || !ctx.sessionsRoot || !ctx.codexSessionIndex) return
  for (const line of text.split('\n')) {
    if (!line || !line.includes('session_meta')) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type !== 'session_meta') continue
    const p = ev.payload ?? {}
    const forkedFrom =
      p.forked_from_id ?? p.forkedFromId ?? p.parent_session_id ?? p.parentSessionId ?? null
    if (!forkedFrom || typeof forkedFrom !== 'string') return
    const forkTs = (p.timestamp as string | undefined) ?? (ev.timestamp as string | undefined) ?? ''
    if (!forkTs) return
    const parentRel = ctx.codexSessionIndex.get(forkedFrom)
    if (!parentRel) return
    const inherited = await codexInheritedTotalsAtFork(join(ctx.sessionsRoot, parentRel), forkTs)
    if (!inherited) return
    ctx.state.codexWalk.inheritedTotals = inherited
    ctx.state.codexWalk.remainingInherited = { ...inherited }
    return
  }
}

function claudeUsageKey(messageId: unknown, requestId: unknown): string | null {
  if (typeof messageId === 'string' && typeof requestId === 'string')
    return `${messageId}:${requestId}`
  return null
}

function claudeCanonicalUsageKey(sessionId: string | null, usageKey: string): string | null {
  if (!sessionId) return null
  return `${sessionId}\0${usageKey}`
}

function claudeSubagentPath(sourceFile: string): boolean {
  return sourceFile.includes('/subagents/')
}

function claudeUsageShouldWin(
  cand: { sourceFile: string; lineNo: number; isSidechain: boolean },
  prev: { sourceFile: string; lineNo: number; isSidechain: boolean },
): boolean {
  if (cand.isSidechain !== prev.isSidechain) return cand.isSidechain
  const candSub = claudeSubagentPath(cand.sourceFile)
  const prevSub = claudeSubagentPath(prev.sourceFile)
  if (candSub !== prevSub) return candSub
  if (cand.sourceFile !== prev.sourceFile) return cand.sourceFile > prev.sourceFile
  return cand.lineNo >= prev.lineNo
}

export function registerClaudeCrossFileWinners(
  registry: ClaudeCrossFileRegistry,
  sourceFile: string,
  sessionId: string | null,
  keyedUsage: Map<string, ClaudeKeyedUsage>,
): void {
  for (const [usageKey, entry] of keyedUsage) {
    const canon = claudeCanonicalUsageKey(sessionId, usageKey)
    if (!canon) continue
    const cand = { sourceFile, lineNo: entry.lineNo, isSidechain: entry.isSidechain }
    const prev = registry.winners.get(canon)
    if (!prev || claudeUsageShouldWin(cand, prev)) registry.winners.set(canon, cand)
  }
}

function finalizeClaudeUsage(rows: Row[], state: ParseState, ctx: ParseContext): void {
  for (const [usageKey, entry] of state.claudeKeyedUsage) {
    const canon = claudeCanonicalUsageKey(state.session_id, usageKey)
    const winner = canon && ctx.claudeCrossFile ? ctx.claudeCrossFile.winners.get(canon) : null
    if (winner && (winner.sourceFile !== ctx.sourceFile || winner.lineNo !== entry.lineNo)) {
      continue
    }
    const onLine = rows.filter((r) => r.source_line === entry.lineNo)
    const carrier =
      onLine.find((r) => r.event_type === 'assistant_message' || r.event_type === 'reasoning') ??
      onLine[0]
    if (!carrier) continue
    carrier.input_tokens = entry.input_tokens
    carrier.output_tokens = entry.output_tokens
    carrier.cache_read_tokens = entry.cache_read_tokens
    carrier.cache_write_tokens = entry.cache_write_tokens
    carrier.model = entry.model ?? carrier.model
    carrier.cost_usd = computeClaudeCost(carrier.model, carrier)
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
  'summary',
  'permission-mode',
  'last-prompt',
  'file-history-snapshot',
  'progress',
  'agent-setting',
  'ai-title',
  'queue-operation',
  'agent-name',
  'custom-title',
  'bridge-session',
  'worktree-state',
])

function parseJsonLine(line: string, lineNo: number, ctx: ParseContext): any {
  try {
    return JSON.parse(line)
  } catch {
    if (!ctx.quiet) {
      const kind = line.trimEnd().endsWith('}') ? 'malformed' : 'truncated'
      console.warn(
        `dropped ${kind} line ${lineNo} in ${ctx.sourceFile} (1 line skipped, rest of session built)`,
      )
    }
    return null
  }
}

function parseClaude(line: string, lineNo: number, ctx: ParseContext): Row | Row[] | null {
  const { state } = ctx
  const ev = parseJsonLine(line, lineNo, ctx)
  if (ev == null) return null
  const msg = ev.message ?? {}
  const usage = msg.usage ?? {}
  const content = msg.content

  // Claude sometimes appends a subagent event twice (same uuid, byte-identical); drop the copy so per-session token/cost totals aren't inflated.
  if (typeof ev.uuid === 'string') {
    if (state.seenEventIds.has(ev.uuid)) return []
    state.seenEventIds.add(ev.uuid)
  }

  // Mint a synthetic session_id `<parent>:<agent-suffix>` per subagent file; keep the real parent sessionId in parent_session_id for rollups.
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
  const usageKey = claudeUsageKey(msg.id, ev.requestId)
  const hasUsage =
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null
  if (usageKey && ev.type === 'assistant' && hasUsage) {
    state.claudeKeyedUsage.set(usageKey, {
      lineNo,
      isSidechain: ev.isSidechain === true,
      model: msg.model ?? state.model,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cache_read_tokens: usage.cache_read_input_tokens ?? null,
      cache_write_tokens: usage.cache_creation_input_tokens ?? null,
    })
  } else if (hasUsage) {
    row.input_tokens = usage.input_tokens ?? null
    row.output_tokens = usage.output_tokens ?? null
    row.cache_read_tokens = usage.cache_read_input_tokens ?? null
    row.cache_write_tokens = usage.cache_creation_input_tokens ?? null
  }
  row.stop_reason = msg.stop_reason ?? null
  row.cwd = ev.cwd ?? state.cwd
  // Claude's raw flag is `isSidechain` (surfaced as is_subagent); subagent rows can be interleaved with main-thread rows in the same file.
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

  // Pure tool-call turns become tool_call; turns with text keep assistant_message/reasoning so role-based queries still see the message.
  if (row.event_type === 'assistant_message' && row.tool_name && !row.text) {
    row.event_type = 'tool_call'
  }

  if (row.input_tokens != null || row.output_tokens != null) {
    row.cost_usd = computeClaudeCost(row.model, row)
  }

  // A 'reasoning' turn with a tool_use also emits a tool_call row so the result has a matching call (Claude messages hold 0-1 tool_use blocks).
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
  const ev = parseJsonLine(line, lineNo, ctx)
  if (ev == null) return []
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

  // Assistant turns can hold multiple toolCall blocks: emit one tool_call row per block.
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
  // Keep the parent row only when it has text/thinking; a tool-calls-only turn puts its tokens on the first tool_call.
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
    // Tokens belong to the message, not each block; put them on the first row when there's no parent to carry them.
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

function parseCodex(line: string, lineNo: number, ctx: ParseContext): Row | null {
  const { state } = ctx
  const ev = parseJsonLine(line, lineNo, ctx)
  if (ev == null) return null
  const p = ev.payload ?? {}

  if (state.session_id == null) {
    state.session_id = parseCodexSessionIdFromFile(ctx.sourceFile)
  }

  if (ev.type === 'session_meta') {
    if (p.id) state.session_id = p.id
    if (p.cwd) state.cwd = p.cwd
    if (p.model_provider) state.provider = p.model_provider
    // Codex spawns subagent threads as separate sessions; session_meta carries source.subagent/forked_from_id, applied to every row in the file.
    if (p.source?.subagent != null || p.forked_from_id != null) {
      state.is_subagent = true
    }
    const forkedFrom =
      p.forked_from_id ?? p.forkedFromId ?? p.parent_session_id ?? p.parentSessionId ?? null
    if (forkedFrom) state.parent_session_id = forkedFrom
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
    if (p.type !== 'token_count') {
      row.event_type = 'session_meta'
    } else {
      const info = (p.info ?? {}) as Record<string, unknown>
      const modelFromInfo = info.model ?? info.model_name ?? p.model ?? ev.model
      const model = (typeof modelFromInfo === 'string' ? modelFromInfo : null) ?? state.model
      if (model) state.model = model
      row.model = model

      const tokenResult = advanceCodexTokenCount(info, state.codexWalk)
      if (!tokenResult) return null
      const { delta } = tokenResult
      if (delta.input === 0 && delta.cached === 0 && delta.output === 0) return null

      row.event_type = 'usage'
      row.input_tokens = delta.input
      row.output_tokens = delta.output
      row.cache_read_tokens = Math.min(delta.cached, delta.input)
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
      // Errors: function_call_output is free-text "Process exited with code N"; custom_tool_call_output is JSON with metadata.exit_code (a plain non-JSON string means failure).
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
    } else if (p.type === 'image_generation_call') {
      row.event_type = 'tool_call'
      row.tool_name = 'image_generation'
      row.tool_call_id = p.id ?? null
      row.tool_input = maybeJson(p.action ?? p.prompt ?? null)
    }
  }

  if (row.input_tokens != null || row.output_tokens != null) {
    row.cost_usd = computeCodexCost(row.model, row)
  }
  return row
}

// Hermes timestamps are timezone-naive local wall clock (filename wall clock matches); append the local UTC offset so TIMESTAMPTZ parsing keeps the wall time.
function hermesTs(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (/[zZ]$/.test(v) || /[+-]\d{2}:?\d{2}$/.test(v)) return v
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return v
  const [, y, mo, d, h, mi, s] = m
  const off = -new Date(+y, +mo - 1, +d, +h, +mi, +s).getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${v}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

// Hermes tool results carry no native is_error; derive it from structured content (exit_code/error/success).
function hermesIsError(content: unknown): boolean {
  const j = maybeJson(content)
  if (typeof j !== 'object' || j == null) return false
  const o = j as Record<string, unknown>
  if (typeof o.exit_code === 'number' && o.exit_code !== 0) return true
  if (o.error) return true
  if (o.success === false) return true
  return false
}

function parseHermes(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const { state } = ctx
  const ev = parseJsonLine(line, lineNo, ctx)
  if (ev == null) return []

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
      // Fan-out row: parent (if any) keeps the base row_id, calls get indexed suffixes.
      cr.row_id = `${cr.row_id}-${callRows.length}`
      cr.ts = hermesTs(ev.timestamp)
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
      parent.ts = hermesTs(ev.timestamp)
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
    row.ts = hermesTs(ev.timestamp)
    row.session_id = state.session_id
    row.event_id = ev.tool_call_id != null ? `${ev.tool_call_id}:result` : null
    row.event_type = 'tool_result'
    row.role = 'tool'
    row.model = state.model
    row.provider = state.provider
    row.cwd = state.cwd
    row.tool_name = ev.name ?? null
    row.tool_call_id = ev.tool_call_id ?? null
    row.tool_output = maybeJson(ev.content)
    // No native is_error; derive from structured content (exit_code/error/success).
    row.is_error = hermesIsError(ev.content)
    return [row]
  }

  // --- user lines ---
  const content = typeof ev.content === 'string' ? ev.content : null
  const row = baseRow(ev, lineNo, ctx)
  row.ts = hermesTs(ev.timestamp)
  row.session_id = state.session_id
  row.event_type = 'user_message'
  row.role = 'user'
  row.model = state.model
  row.provider = state.provider
  row.cwd = state.cwd
  row.text = content ?? null
  return [row]
}

// Cursor lines are pre-normalized by collect-cursor.ts (SQLite → slim role-tagged JSON), so this parser stays a thin role mapper: one session_meta, then one line per bubble; tool bubbles fan out to tool_call + tool_result; timestamps are collector-synthesized (Cursor bubbles carry none).
function parseCursor(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const { state } = ctx
  const ev = JSON.parse(line)

  if (ev.role === 'session_meta') {
    state.session_id = ev.composerId ?? null
    state.cwd = ev.cwd ?? null
    state.model = ev.model ?? null
    const row = baseRow(ev, lineNo, ctx)
    row.ts = ev.ts ?? null
    row.event_id = ev.composerId ?? null
    row.event_type = 'session_meta'
    row.text = ev.name ?? null
    return [row]
  }

  if (ev.model) state.model = ev.model

  if (ev.role === 'user') {
    const row = baseRow(ev, lineNo, ctx)
    row.ts = ev.ts ?? null
    row.event_id = ev.bubbleId ?? null
    row.event_type = 'user_message'
    row.role = 'user'
    row.text = ev.text ?? null
    return [row]
  }

  // assistant lines: tool call, reasoning, or plain message
  const tool = ev.tool
  if (tool) {
    const call = baseRow(ev, lineNo, ctx)
    call.ts = ev.ts ?? null
    call.event_id = tool.callId ?? ev.bubbleId ?? null
    call.event_type = 'tool_call'
    call.role = 'assistant'
    call.tool_name = tool.name ?? null
    call.tool_call_id = tool.callId ?? null
    call.tool_input = maybeJson(tool.args ?? null)
    if (tool.result == null) return [call]
    const result = baseRow(ev, lineNo, ctx)
    result.ts = ev.ts ?? null
    result.row_id = `${result.row_id}-result`
    result.event_id = tool.callId ? `${tool.callId}:result` : null
    result.parent_id = tool.callId ?? null
    result.event_type = 'tool_result'
    result.role = 'tool'
    result.tool_name = tool.name ?? null
    result.tool_call_id = tool.callId ?? null
    result.tool_output = maybeJson(tool.result)
    result.is_error = tool.isError === true
    return [call, result]
  }

  const row = baseRow(ev, lineNo, ctx)
  row.ts = ev.ts ?? null
  row.event_id = ev.bubbleId ?? null
  row.event_type = ev.isThought ? 'reasoning' : 'assistant_message'
  row.role = 'assistant'
  row.text = ev.text ?? null
  row.input_tokens = ev.inputTokens ?? null
  row.output_tokens = ev.outputTokens ?? null
  return [row]
}

const PARSERS: Record<Agent, (l: string, n: number, c: ParseContext) => Row | Row[] | null> = {
  claude: parseClaude,
  pi: parsePi,
  codex: parseCodex,
  hermes: parseHermes,
  cursor: parseCursor,
}

export function parseLine(line: string, lineNo: number, ctx: ParseContext): Row[] {
  const result = PARSERS[ctx.agent](line, lineNo, ctx)
  if (result == null) return []
  return Array.isArray(result) ? result : [result]
}

/** Build a ParseContext for one session file. */
export function makeParseContext(
  agent: Agent,
  sourceFile: string,
  sessionsRoot: string,
  codexSessionIndex: ReadonlyMap<string, string>,
  claudeCrossFile?: ClaudeCrossFileRegistry,
): ParseContext {
  return {
    agent,
    sourceFile,
    state: newState(),
    sessionsRoot,
    codexSessionIndex,
    ...(claudeCrossFile ? { claudeCrossFile } : {}),
  }
}

export type ParseSessionOptions = {
  /** Pass 1 of claude build: register cross-file usage winners only. */
  registerClaudeCrossFile?: boolean
}

/** Parse one full session's text into rows; empty split lines (incl. the trailing one) are ignored. */
export async function parseSessionText(
  text: string,
  ctx: ParseContext,
  opts?: ParseSessionOptions,
): Promise<Row[]> {
  if (opts?.registerClaudeCrossFile) ctx.quiet = true
  if (ctx.agent === 'codex') await preloadCodexForkInheritance(text, ctx)
  const rows: Row[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    for (const row of parseLine(line, i + 1, ctx)) rows.push(row)
  }
  if (ctx.agent === 'claude') {
    if (opts?.registerClaudeCrossFile && ctx.claudeCrossFile) {
      registerClaudeCrossFileWinners(
        ctx.claudeCrossFile,
        ctx.sourceFile,
        ctx.state.session_id,
        ctx.state.claudeKeyedUsage,
      )
    } else {
      finalizeClaudeUsage(rows, ctx.state, ctx)
    }
  }
  return rows
}

// Claude build pass 1: pick one usage winner per (session, message, request) across all claude files so finalize suppresses duplicates from resumed/subagent/sidechain copies. Skipped unless some claude file is stale (then rescan all — a winner in an unchanged file can still suppress usage in a rebuilt one); winners follow a total order, so scan order doesn't matter.
export async function populateClaudeCrossFile(
  registry: ClaudeCrossFileRegistry,
  sessionsRoot: string,
  codexSessionIndex: ReadonlyMap<string, string>,
  needsRebuild: (src: string) => Promise<boolean>,
): Promise<void> {
  const files: string[] = []
  for await (const src of new Bun.Glob('claude/**/*.jsonl').scan({
    cwd: sessionsRoot,
    absolute: true,
    onlyFiles: true,
  }))
    files.push(src)
  const stale = (await Promise.all(files.map(needsRebuild))).some(Boolean)
  if (!stale) return
  for (const src of files) {
    const ctx = makeParseContext(
      'claude',
      relative(sessionsRoot, src),
      sessionsRoot,
      codexSessionIndex,
      registry,
    )
    await parseSessionText(await Bun.file(src).text(), ctx, { registerClaudeCrossFile: true })
  }
}
