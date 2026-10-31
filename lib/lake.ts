// Where the lake lives on disk and how to open it: session → parquet paths, the `events` view SQL (lib/events.sql with paths filled in), and the stale-parquet warning shared by status and query.
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { plural } from './ui.ts'

const repo = join(import.meta.dir, '..')
export const SESSIONS_ROOT = join(repo, 'data/sessions')
export const PARQUET_ROOT = join(repo, 'data/parquet')
export const PARQUET_GLOB = join(PARQUET_ROOT, '**/*.parquet')
const PRICES_PATH = join(repo, 'data/prices.json')
const DUPLICATES_PATH = join(repo, 'data/duplicates.json')
// Before the first build there's no price or duplicate table; join an empty one so queries still run.
const EMPTY_PATH = join(import.meta.dir, 'empty.json')

// data/sessions/<agent>/<rel>.jsonl → data/parquet/agent=<agent>/<rel>.parquet
export function parquetPathFor(agent: string, src: string): string {
  const rel = relative(join(SESSIONS_ROOT, agent), src).replace(/\.jsonl$/, '.parquet')
  return join(PARQUET_ROOT, `agent=${agent}`, rel)
}

// A single quote in a path closes the SQL literal early; double it.
const sqlStr = (s: string) => s.replaceAll("'", "''")

export async function eventsSql(): Promise<string> {
  const orEmpty = async (path: string) => ((await Bun.file(path).exists()) ? path : EMPTY_PATH)
  return (await Bun.file(join(import.meta.dir, 'events.sql')).text())
    .replaceAll('{parquet}', sqlStr(PARQUET_GLOB))
    .replaceAll('{prices}', sqlStr(await orEmpty(PRICES_PATH)))
    .replaceAll('{duplicates}', sqlStr(await orEmpty(DUPLICATES_PATH)))
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

// Sessions the lake is missing: no parquet, or the source changed since it was built. Same rule build uses to pick what to rebuild, so this is empty exactly when a build would do nothing. Paths are relative to data/sessions.
export async function unbuiltSessions(agents: readonly string[]): Promise<string[]> {
  const unbuilt: string[] = []
  for await (const src of new Bun.Glob('**/*.jsonl').scan({ cwd: SESSIONS_ROOT, absolute: true })) {
    const rel = relative(SESSIONS_ROOT, src)
    const agent = rel.split(/[\\/]/)[0]!
    if (!agents.includes(agent)) continue
    const [srcM, outM] = await Promise.all([mtime(src), mtime(parquetPathFor(agent, src))])
    if (srcM == null || outM == null || outM < srcM) unbuilt.push(rel)
  }
  return unbuilt.sort()
}

export async function staleParquetWarning(agents: readonly string[]): Promise<string | null> {
  const unbuilt = await unbuiltSessions(agents)
  if (!unbuilt.length) return null
  return `warning: ${plural(unbuilt.length, 'session')} in data/sessions not built yet — run 'llmlake build' to refresh.`
}
