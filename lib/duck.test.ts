import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let binDir: string

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'llmlake-duck-test-'))
  const duckdb = join(binDir, 'duckdb')
  await writeFile(duckdb, '#!/bin/sh\ncat >/dev/null\necho "Parser Error: bad query" >&2\nexit 0\n')
  await chmod(duckdb, 0o755)
})

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true })
})

test('reports missing result files as failed questions', async () => {
  const script =
    `import { runQuestions } from ${JSON.stringify(join(import.meta.dir, 'duck.ts'))};` +
    `try { await runQuestions('', { broken_panel: 'not valid sql' }) } ` +
    `catch (error) { console.log(error.message) }`
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect(await new Response(proc.stdout).text()).toBe(
    'DuckDB query failed (questions: broken_panel)\nParser Error: bad query\n',
  )
  expect(await proc.exited).toBe(0)
})
