// Per-million-token USD prices, keyed by exact model string as logged.
// Pi rows already carry a provider-recorded cost; this table is used to
// compute cost for Claude and Codex rows at parse time.
//
// Cache pricing assumes Anthropic's 5-minute ephemeral cache: cache_read =
// 0.1× input, cache_write = 1.25× input. For OpenAI/Codex, cached_input is
// 0.25× input. Override per-model below if you need different ratios.

export type Price = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

export const PRICING: Record<string, Price> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-opus-4-5-20251101': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
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

// Anthropic convention: input_tokens excludes cache reads/writes (they are
// reported as separate counters). Total cost sums all four buckets.
export function computeClaudeCost(model: string | null, t: Tokens): number | null {
  if (!model) return null
  const p = PRICING[model]
  if (!p) return null
  const cacheReadRate = p.cache_read ?? p.input * 0.1
  const cacheWriteRate = p.cache_write ?? p.input * 1.25
  return (
    ((t.input_tokens ?? 0) * p.input +
      (t.output_tokens ?? 0) * p.output +
      (t.cache_read_tokens ?? 0) * cacheReadRate +
      (t.cache_write_tokens ?? 0) * cacheWriteRate) /
    1e6
  )
}

// OpenAI convention: input_tokens already includes cached_input_tokens. Fresh
// input is the difference; cached portion is billed at the discounted rate.
export function computeCodexCost(model: string | null, t: Tokens): number | null {
  if (!model) return null
  const p = PRICING[model]
  if (!p) return null
  const cachedRate = p.cache_read ?? p.input * 0.25
  const inTok = t.input_tokens ?? 0
  const cachedTok = t.cache_read_tokens ?? 0
  const freshIn = Math.max(0, inTok - cachedTok)
  return (freshIn * p.input + cachedTok * cachedRate + (t.output_tokens ?? 0) * p.output) / 1e6
}
