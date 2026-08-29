// Shared duckdb-subprocess helpers: a version guard and a batch query runner over the duckdb CLI (already a prerequisite).
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

// Run every query in one duckdb process (`init` first, e.g. CREATE VIEW): each result is COPYd to its own temp JSON and read back (no stdout stream to parse). `.bail off` lets independent queries finish; missing result files identify the failures.
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
    const proc = Bun.spawn(['duckdb'], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
    const stderr = new Response(proc.stderr).text()
    await proc.stdin.write(['.bail off', init, ...copies, ''].join('\n'))
    await proc.stdin.end()
    const [exitCode, errorOutput] = await Promise.all([proc.exited, stderr])

    const results: Record<string, Row[]> = {}
    const failed: string[] = []
    await Promise.all(
      ids.map(async (id) => {
        try {
          const text = await readFile(`${join(dir, id)}.json`, 'utf8')
          results[id] = JSON.parse(text || '[]') as Row[]
        } catch {
          failed.push(id)
        }
      }),
    )
    if (exitCode !== 0 || failed.length > 0) {
      const questions = failed.length > 0 ? ` (questions: ${failed.sort().join(', ')})` : ''
      const detail = errorOutput.trim()
      throw new Error(`DuckDB query failed${questions}${detail ? `\n${detail}` : ''}`)
    }
    return results
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
