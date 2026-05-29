// Per-million-token USD prices, keyed by exact model string as logged.
// Pi rows already carry a provider-recorded cost; this table is used to
// compute cost for Claude and Codex rows at parse time.
//
// Prices come from two sources, merged at module load:
//   1. litellm-pricing.json — a filtered mirror of LiteLLM's community price
//      list (refresh with ./sync-pricing.ts). Covers the long tail of models
//      and carries above-200k tier rates and context limits.
//   2. The PRICING table below — curated overrides that always win over the
//      snapshot, and a floor for brand-new models LiteLLM hasn't listed yet.
//
// Cache pricing assumes Anthropic's 5-minute ephemeral cache: cache_read =
// 0.1× input, cache_write = 1.25× input. For OpenAI/Codex, cached_input is
// 0.25× input. Override per-model below if you need different ratios.
import LITELLM from './litellm-pricing.json' with { type: 'json' }

export type Price = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  // Marginal rates for tokens above 200k of context (Anthropic long-context
  // tier). Absent means the model is billed at the flat rate regardless of size.
  input_above_200k?: number
  output_above_200k?: number
  cache_read_above_200k?: number
  cache_write_above_200k?: number
}

export const PRICING: Record<string, Price> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-opus-4-5-20251101': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },

  // OpenAI
  'gpt-5-codex': { input: 1.75, output: 14.0 }, // pre-versioning name for 5.3-codex (seen Jan–Mar 2026)
  'gpt-5.3-codex': { input: 1.75, output: 14.0 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.5': { input: 5.0, output: 30.0 },

  // Qwen pricing varies by provider ($0.32–0.60 / $2.00–3.20). Omitted until
  // we know the actual provider Pi routes to.
}

type Tokens = {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

const CODEX_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/
const CLAUDE_DATE_SUFFIX = /-\d{8}$/
const CLAUDE_VERSION_SUFFIX = /-v\d+:\d+$/

// LiteLLM reports per-token USD; we bill in per-million. One pass at load time
// converts the snapshot into the Price shape and merges the curated overrides.
type LitellmEntry = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  input_cost_per_token_above_200k_tokens?: number
  output_cost_per_token_above_200k_tokens?: number
  cache_creation_input_token_cost_above_200k_tokens?: number
  cache_read_input_token_cost_above_200k_tokens?: number
}

function fromLitellm(e: LitellmEntry): Price | undefined {
  if (e.input_cost_per_token == null || e.output_cost_per_token == null) return undefined
  const M = 1e6
  const p: Price = { input: e.input_cost_per_token * M, output: e.output_cost_per_token * M }
  if (e.cache_creation_input_token_cost != null)
    p.cache_write = e.cache_creation_input_token_cost * M
  if (e.cache_read_input_token_cost != null) p.cache_read = e.cache_read_input_token_cost * M
  if (e.input_cost_per_token_above_200k_tokens != null)
    p.input_above_200k = e.input_cost_per_token_above_200k_tokens * M
  if (e.output_cost_per_token_above_200k_tokens != null)
    p.output_above_200k = e.output_cost_per_token_above_200k_tokens * M
  if (e.cache_creation_input_token_cost_above_200k_tokens != null)
    p.cache_write_above_200k = e.cache_creation_input_token_cost_above_200k_tokens * M
  if (e.cache_read_input_token_cost_above_200k_tokens != null)
    p.cache_read_above_200k = e.cache_read_input_token_cost_above_200k_tokens * M
  return p
}

// Merged lookup: LiteLLM snapshot as the base, curated PRICING overlaid on top.
// Spreading the curated entry over the snapshot keeps the snapshot's tier fields
// while letting hand-entered input/output/cache rates win.
const MERGED: Record<string, Price> = {}
for (const [model, entry] of Object.entries(LITELLM as Record<string, LitellmEntry>)) {
  const p = fromLitellm(entry)
  if (p) MERGED[model] = p
}
for (const [model, override] of Object.entries(PRICING)) {
  MERGED[model] = { ...MERGED[model], ...override }
}

// Resolved-price cache. parse-session calls compute* once per row and the same
// model string repeats across a session, so memoizing turns the fuzzy scan into
// a one-time cost per distinct model name.
const RESOLVED = new Map<string, Price | null>()

// --- Fuzzy model matching (ported from ccusage) -----------------------------
// Logged model names carry provider prefixes (anthropic., openai/, openrouter/
// anthropic/...), separator variants (claude-opus-4.8 vs -4-8, @ in vertex
// names) and date suffixes. We match across those while refusing to fall back
// across distinct numeric versions (so claude-opus-4.8 never bills as opus-4).

const isBoundary = (code: number): boolean =>
  !((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))

const normalizeKey = (s: string): string =>
  s.includes('.') || s.includes('@') ? s.replace(/[.@]/g, '-') : s

// A YYYYMMDD suffix is an alias of the same model; any other numeric suffix is a
// different version we must not collapse into.
function suffixStartsWithNumericVersion(key: string, suffix: string): boolean {
  if (!/[0-9]$/.test(key)) return false
  if (suffix[0] !== '-' && suffix[0] !== '.') return false
  const rest = suffix.slice(1)
  const digits = rest.match(/^[0-9]+/)?.[0]
  if (!digits) return false
  const after = rest.charCodeAt(digits.length) // NaN when at end
  const isDate = digits.length === 8 && (Number.isNaN(after) || isBoundary(after))
  return !isDate
}

function suffixAllowsMatch(key: string, suffix: string): boolean {
  if (suffix.length === 0) return true
  if (!isBoundary(suffix.charCodeAt(0))) return false
  return !suffixStartsWithNumericVersion(key, suffix)
}

// True when `key` appears in `value` flanked by model-name boundaries.
function containsKey(value: string, key: string): boolean {
  let from = 0
  for (;;) {
    const i = value.indexOf(key, from)
    if (i < 0) return false
    const beforeOk = i === 0 || isBoundary(value.charCodeAt(i - 1))
    if (beforeOk && suffixAllowsMatch(key, value.slice(i + key.length))) return true
    from = i + 1
  }
}

function keyMatches(candidate: string, model: string, normModel: string): boolean {
  if (containsKey(model, candidate) || containsKey(candidate, model)) return true
  const normCandidate = normalizeKey(candidate)
  return containsKey(normModel, normCandidate) || containsKey(normCandidate, normModel)
}

function fuzzyFind(model: string): Price | undefined {
  const normModel = normalizeKey(model)
  let best: string | undefined
  for (const candidate of Object.keys(MERGED)) {
    if (!keyMatches(candidate, model, normModel)) continue
    // Prefer the longest key (most specific); tie-break to the lexicographically
    // smaller name, matching ccusage's resolution order.
    if (
      best === undefined ||
      candidate.length > best.length ||
      (candidate.length === best.length && candidate < best)
    )
      best = candidate
  }
  return best === undefined ? undefined : MERGED[best]
}

function findPrice(model: string): Price | undefined {
  const cached = RESOLVED.get(model)
  if (cached !== undefined) return cached ?? undefined
  const price = MERGED[model] ?? fuzzyFind(model)
  RESOLVED.set(model, price ?? null)
  return price
}

export function normalizeClaudeModel(raw: string): string {
  let m = raw.trim()
  if (m.startsWith('anthropic.')) m = m.slice('anthropic.'.length)
  const dot = m.lastIndexOf('.')
  if (dot >= 0 && m.includes('claude-')) {
    const tail = m.slice(dot + 1)
    if (tail.startsWith('claude-')) m = tail
  }
  m = m.replace(CLAUDE_VERSION_SUFFIX, '')
  if (CLAUDE_DATE_SUFFIX.test(m)) {
    const base = m.replace(CLAUDE_DATE_SUFFIX, '')
    if (MERGED[base]) return base
  }
  return m
}

export function normalizeCodexModel(raw: string): string {
  let m = raw.trim()
  if (m.startsWith('openai/')) m = m.slice('openai/'.length)
  if (MERGED[m]) return m
  if (CODEX_DATE_SUFFIX.test(m)) {
    const base = m.replace(CODEX_DATE_SUFFIX, '')
    if (MERGED[base]) return base
  }
  return m
}

// Cost for `tokens` of one bucket. Anthropic bills tokens beyond 200k of context
// at a higher marginal rate; absent a tier rate, the whole bucket is flat. Rates
// are per-million, so divide once at the end.
function tieredCost(tokens: number, rate: number, above: number | undefined): number {
  const THRESHOLD = 200_000
  if (tokens <= 0) return 0
  if (above != null && tokens > THRESHOLD)
    return (THRESHOLD * rate + (tokens - THRESHOLD) * above) / 1e6
  return (tokens * rate) / 1e6
}

// Anthropic convention: input_tokens excludes cache reads/writes (they are
// reported as separate counters). Total cost sums all four buckets.
export function computeClaudeCost(model: string | null, t: Tokens): number | null {
  if (!model) return null
  const p = findPrice(normalizeClaudeModel(model))
  if (!p) return null
  const cacheReadRate = p.cache_read ?? p.input * 0.1
  const cacheWriteRate = p.cache_write ?? p.input * 1.25
  return (
    tieredCost(t.input_tokens ?? 0, p.input, p.input_above_200k) +
    tieredCost(t.output_tokens ?? 0, p.output, p.output_above_200k) +
    tieredCost(t.cache_read_tokens ?? 0, cacheReadRate, p.cache_read_above_200k) +
    tieredCost(t.cache_write_tokens ?? 0, cacheWriteRate, p.cache_write_above_200k)
  )
}

// OpenAI convention: input_tokens already includes cached_input_tokens. Fresh
// input is the difference; cached portion is billed at the discounted rate.
export function computeCodexCost(model: string | null, t: Tokens): number | null {
  if (!model) return null
  const p = findPrice(normalizeCodexModel(model))
  if (!p) return null
  const cachedRate = p.cache_read ?? p.input * 0.25
  const inTok = t.input_tokens ?? 0
  const cachedTok = t.cache_read_tokens ?? 0
  const freshIn = Math.max(0, inTok - cachedTok)
  return (
    tieredCost(freshIn, p.input, p.input_above_200k) +
    (cachedTok * cachedRate) / 1e6 +
    tieredCost(t.output_tokens ?? 0, p.output, p.output_above_200k)
  )
}
