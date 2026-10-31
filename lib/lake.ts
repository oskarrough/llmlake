// Where the lake lives on disk and how to open it: session → parquet paths and the `events` view SQL (lib/events.sql with paths filled in).
import { join, relative } from 'node:path'

const repo = join(import.meta.dir, '..')
export const SESSIONS_ROOT = join(repo, 'data/sessions')
export const PARQUET_ROOT = join(repo, 'data/parquet')
export const PARQUET_GLOB = join(PARQUET_ROOT, '**/*.parquet')
const PRICES_PATH = join(repo, 'data/prices.json')
// Before the first build there's no price table; join an empty one so queries still run.
const NO_PRICES_PATH = join(import.meta.dir, 'no-prices.json')

// data/sessions/<agent>/<rel>.jsonl → data/parquet/agent=<agent>/<rel>.parquet
export function parquetPathFor(agent: string, src: string): string {
  const rel = relative(join(SESSIONS_ROOT, agent), src).replace(/\.jsonl$/, '.parquet')
  return join(PARQUET_ROOT, `agent=${agent}`, rel)
}

// A single quote in a path closes the SQL literal early; double it.
const sqlStr = (s: string) => s.replaceAll("'", "''")

export async function eventsSql(): Promise<string> {
  const prices = (await Bun.file(PRICES_PATH).exists()) ? PRICES_PATH : NO_PRICES_PATH
  return (await Bun.file(join(import.meta.dir, 'events.sql')).text())
    .replaceAll('{parquet}', sqlStr(PARQUET_GLOB))
    .replaceAll('{prices}', sqlStr(prices))
}
