// Per-million USD prices keyed by exact model string. Pi rows carry their own cost; this prices Claude and Codex rows at parse time. Sources merged at load: litellm-pricing.json (filtered LiteLLM mirror, refresh with ./sync-pricing.ts) + the curated PRICING table, which always wins. Cache assumes Anthropic's 5-min cache (read 0.1×, write 1.25× input); OpenAI cached_input 0.25×.
import LITELLM from './litellm-pricing.json' with { type: 'json' }

export type Price = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  // Marginal rates above 200k context (Anthropic long-context tier); absent = flat rate.
  input_above_200k?: number
  output_above_200k?: number
  cache_read_above_200k?: number
  cache_write_above_200k?: number
}

export const PRICING: Record<string, Price> = {
  // Anthropic (first-party API rates; Fable cache reads are $0.25/M, others default to 0.1× input)
  'claude-fable-5-1': { input: 10.0, output: 50.0, cache_read: 0.25 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
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

  // Qwen omitted: pricing varies by provider until we know which one Pi routes to.
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

// LiteLLM reports per-token USD; convert to per-million at load and merge the curated overrides.
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

// LiteLLM snapshot as base, curated PRICING spread over it (keeps snapshot tier fields, curated rates win).
const MERGED: Record<string, Price> = {}
for (const [model, entry] of Object.entries(LITELLM as Record<string, LitellmEntry>)) {
  const p = fromLitellm(entry)
  if (p) MERGED[model] = p
}
for (const [model, override] of Object.entries(PRICING)) {
  MERGED[model] = { ...MERGED[model], ...override }
}

// Memoized price lookup: the same model string repeats across rows, so the fuzzy scan runs once per distinct name.
const RESOLVED = new Map<string, Price | null>()

// --- Fuzzy model matching (ported from ccusage) -----------------------------
// Logged names carry provider prefixes, separator variants and date suffixes; match across those but never collapse distinct numeric versions.

const isBoundary = (code: number): boolean =>
  !((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))

const normalizeKey = (s: string): string =>
  s.includes('.') || s.includes('@') ? s.replace(/[.@]/g, '-') : s

// A YYYYMMDD suffix is an alias; any other numeric suffix is a different version we must not collapse into.
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
    // Prefer the longest (most specific) key; tie-break lexicographically, matching ccusage.
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

// One bucket's cost; tokens beyond 200k bill at the higher marginal rate when present. Rates are per-million.
function tieredCost(tokens: number, rate: number, above: number | undefined): number {
  const THRESHOLD = 200_000
  if (tokens <= 0) return 0
  if (above != null && tokens > THRESHOLD)
    return (THRESHOLD * rate + (tokens - THRESHOLD) * above) / 1e6
  return (tokens * rate) / 1e6
}

// Anthropic convention: input_tokens excludes cache reads/writes (separate counters); sum all four buckets.
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

// OpenAI convention: input_tokens includes cached_input_tokens; fresh input is the difference.
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
