#!/usr/bin/env bun
// Refresh the LiteLLM pricing snapshot mirrored into litellm-pricing.json (run occasionally: ./sync-pricing.ts). Only entries with both input+output prices and only billed fields are kept, so pricing works offline; the curated PRICING table in pricing.ts always overrides.
import { join } from 'node:path'

const URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Only the per-token fields pricing.ts reads, plus the context limit — the rest is dropped to keep the snapshot small.
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

const res = await fetch(URL)
if (!res.ok) {
  console.error(`fetch failed: HTTP ${res.status}`)
  process.exit(1)
}
const raw = (await res.json()) as Record<string, Record<string, unknown>>

const out: Record<string, Record<string, number>> = {}
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

// Sorted keys keep the committed diff stable across refreshes.
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
const dest = join(import.meta.dir, 'litellm-pricing.json')
await Bun.write(dest, JSON.stringify(sorted))
console.log(
  `wrote ${Object.keys(sorted).length} models → ${dest} (${(Bun.file(dest).size / 1024) | 0} KB)`,
)
