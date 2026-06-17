// Shared duckdb-subprocess helpers. The project talks to the duckdb CLI
// (already a prerequisite) rather than a native binding, so these wrap spawning
// it: a version guard and a batch query runner.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Row = Record<string, unknown>

// Verify the duckdb CLI is on PATH; exit with install instructions if not.
export function ensureDuckdb(): void {
  try {
    Bun.spawnSync(['duckdb', '--version'])
  } catch {
    console.error('duckdb not found. Install it from https://duckdb.org/docs/installation/')
    process.exit(1)
  }
}

// Run every query in a single duckdb process, returning each result's rows
// keyed by the same id. `init` runs first (e.g. CREATE VIEW ...). Each result
// is written to its own temp JSON file via COPY, then read back — there's no
// stdout stream to parse. One process means any parquet is scanned once, and
// the result files are a few KB. `.bail off` keeps a single failing query from
// killing the rest; a missing file simply means that query produced no rows.
export async function runQuestions(
  init: string,
  queries: Record<string, string>,
): Promise<Record<string, Row[]>> {
  const dir = await mkdtemp(join(tmpdir(), 'llmlake-'))
  try {
    const ids = Object.keys(queries)
    const copies = ids.map(
      (id) =>
        `COPY (${queries[id]!.trim().replace(/;\s*$/, '')}) TO '${join(dir, id)}.json' (FORMAT json, ARRAY true);`,
    )
    const proc = Bun.spawn(['duckdb'], { stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' })
    await proc.stdin.write(['.bail off', init, ...copies, ''].join('\n'))
    await proc.stdin.end()
    await proc.exited

    const results: Record<string, Row[]> = {}
    await Promise.all(
      ids.map(async (id) => {
        results[id] = await readFile(`${join(dir, id)}.json`, 'utf8')
          .then((t) => JSON.parse(t || '[]') as Row[])
          .catch(() => [])
      }),
    )
    return results
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
