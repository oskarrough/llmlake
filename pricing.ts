// Per-million USD prices keyed by model string, resolved at build time into data/prices.json (lib/prices.ts) and applied to token counts at query time (lib/events.sql). Sources merged: the LiteLLM price list (fetched each build, committed snapshot litellm-pricing.json as offline fallback) + the curated PRICING table, which always wins. Missing cache rates default per vendor: Anthropic's 5-min cache (read 0.1×, write 1.25× input), others read 0.25× and write 1× input.
import { join } from 'node:path'

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

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Only the per-token fields this file reads, plus the context limit — the rest is dropped to keep the snapshot small.
const KEEP = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_read_input_token_cost',
  'input_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'cache_creation_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost_above_200k_tokens',
  'max_input_tokens',
] as const

export type Litellm = Record<string, Record<string, number>>

// Download LiteLLM's price list, keeping entries with both input+output prices and only the KEEP fields; sorted keys keep the committed snapshot's diff stable.
export async function fetchLitellm(timeoutMs = 10_000): Promise<Litellm> {
  const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, Record<string, unknown>>
  const out: Litellm = {}
  for (const [model, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    if (value.input_cost_per_token == null || value.output_cost_per_token == null) continue
    // Drop Vertex aliases: they duplicate canonical keys; the fuzzy matcher resolves vertex_ai/… names anyway.
    if (model.includes('vertex_ai/')) continue
    const entry: Record<string, number> = {}
    for (const field of KEEP) {
      const v = value[field]
      if (typeof v === 'number') entry[field] = v
    }
    out[model] = entry
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

export const SNAPSHOT_PATH = join(import.meta.dir, 'litellm-pricing.json')

const CODEX_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/
const CLAUDE_DATE_SUFFIX = /-\d{8}$/
const CLAUDE_VERSION_SUFFIX = /-v\d+:\d+$/

// LiteLLM reports per-token USD; convert to per-million and merge the curated overrides.
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

// Build a memoized model → price lookup over LiteLLM + the curated overrides. Only exact keys count, tried in this order: the logged name; its Claude/Codex normalization (date and version suffixes); the name without a router prefix (`openai/gpt-5.6-sol`, `~deepseek/…`) and with dotted versions dashed (`claude-opus-4.8` → `claude-opus-4-8`); finally, for namespaced ids only, the same id listed under a host (`novita/deepseek/…`, `fireworks_ai/accounts/fireworks/…`), shortest key first. Never substring matches: a bare alias like `sonnet` would grab whichever Sonnet listing is longest. Returns the key it matched so every price can be traced.
export type PriceMatch = { key: string; price: Price }
export function createPriceLookup(litellm: Litellm): (model: string) => PriceMatch | undefined {
  // LiteLLM as base, curated PRICING spread over it (keeps LiteLLM tier fields, curated rates win).
  const merged: Record<string, Price> = {}
  for (const [model, entry] of Object.entries(litellm as Record<string, LitellmEntry>)) {
    const p = fromLitellm(entry)
    if (p) merged[model] = p
  }
  for (const [model, override] of Object.entries(PRICING)) {
    merged[model] = { ...merged[model], ...override }
  }

  const keys = Object.keys(merged)
  const exact = (name: string) => (merged[name] ? name : undefined)

  // The name as a router logs it, minus one `vendor/` or `~vendor/` prefix, each also with dotted versions dashed.
  function spellings(model: string): string[] {
    const out = new Set<string>()
    for (const name of [model, model.replace(/^~?[\w.-]+\//, '')]) {
      out.add(name)
      out.add(name.replace(/(\d)\.(\d)/g, '$1-$2'))
    }
    return [...out]
  }

  function hostListing(model: string): string | undefined {
    if (!model.includes('/')) return undefined
    const tail = '/' + model
    let best: string | undefined
    for (const key of keys) {
      if (!key.endsWith(tail)) continue
      if (
        best === undefined ||
        key.length < best.length ||
        (key.length === best.length && key < best)
      )
        best = key
    }
    return best
  }

  function normalizeClaudeModel(raw: string): string {
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
      if (merged[base]) return base
    }
    return m
  }

  function normalizeCodexModel(raw: string): string {
    let m = raw.trim()
    if (m.startsWith('openai/')) m = m.slice('openai/'.length)
    if (merged[m]) return m
    if (CODEX_DATE_SUFFIX.test(m)) {
      const base = m.replace(CODEX_DATE_SUFFIX, '')
      if (merged[base]) return base
    }
    return m
  }

  // The same model string repeats across the lake, so each distinct name resolves once.
  const resolved = new Map<string, PriceMatch | null>()
  return (model) => {
    const cached = resolved.get(model)
    if (cached !== undefined) return cached ?? undefined
    const name = model.includes('claude') ? normalizeClaudeModel(model) : normalizeCodexModel(model)
    const key =
      exact(model) ?? exact(name) ?? spellings(model).map(exact).find(Boolean) ?? hostListing(model)
    const match = key ? { key, price: merged[key]! } : null
    resolved.set(model, match)
    return match ?? undefined
  }
}

export type PriceRow = Required<Pick<Price, 'input' | 'output' | 'cache_read' | 'cache_write'>> &
  Pick<
    Price,
    'input_above_200k' | 'output_above_200k' | 'cache_read_above_200k' | 'cache_write_above_200k'
  > & { model: string; matched: string }

// Fill missing cache rates with the vendor default so the SQL never multiplies by NULL.
export function priceRow(model: string, { key, price: p }: PriceMatch): PriceRow {
  const anthropic = model.includes('claude')
  return {
    model,
    matched: key,
    ...p,
    cache_read: p.cache_read ?? p.input * (anthropic ? 0.1 : 0.25),
    cache_write: p.cache_write ?? p.input * (anthropic ? 1.25 : 1),
  }
}
