#!/usr/bin/env bun
// Parse one agent JSONL session into a normalized parquet file.
// Usage: ./build-one.ts <session.jsonl> [out.parquet]
import { basename, dirname, join, relative } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { Schema } from 'effect'
import {
  AGENTS,
  buildCodexSessionIndex,
  colsSql,
  makeParseContext,
  parseSessionText,
  RowSchema,
  type Agent,
  type Row,
} from './parse-session.ts'
import { ensureDuckdb } from './lib/duck.ts'

ensureDuckdb()

const validateRow = Schema.validateSync(RowSchema)

const src = process.argv[2]
if (!src) {
  console.error('usage: build-one.ts <session.jsonl> [out.parquet]')
  process.exit(1)
}

const sessionsRoot = join(import.meta.dir, 'data/sessions')
const sourceFile = relative(sessionsRoot, await realpath(src))
const agent = sourceFile.split(/[\\/]/)[0] as Agent
if (!AGENTS.includes(agent)) {
  console.error(
    `error: source must be under data/sessions/<${AGENTS.join('|')}>/ (got: ${sourceFile})`,
  )
  process.exit(1)
}

const out =
  process.argv[3] ??
  join(
    import.meta.dir,
    `data/parquet/agent=${agent}`,
    basename(src).replace(/\.jsonl$/, '.parquet'),
  )

const codexSessionIndex = await buildCodexSessionIndex(sessionsRoot)
const ctx = makeParseContext(agent, sourceFile, sessionsRoot, codexSessionIndex)
const rows: Row[] = []
for (const row of await parseSessionText(await Bun.file(src).text(), ctx)) {
  try {
    rows.push(validateRow(row))
  } catch (cause) {
    console.error(`row validation failed at ${ctx.sourceFile}:${row.source_line}`)
    throw cause
  }
}

await mkdir(dirname(out), { recursive: true })

const proc = Bun.spawn(
  [
    'duckdb',
    '-c',
    `COPY (SELECT * FROM read_json('/dev/stdin', format='newline_delimited', columns={${colsSql}})) TO '${out}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  ],
  {
    stdin: new Blob([rows.map((r) => JSON.stringify(r)).join('\n') + '\n']),
    stdout: 'inherit',
    stderr: 'inherit',
  },
)
if ((await proc.exited) !== 0) process.exit(1)

console.log(`wrote ${rows.length} rows -> ${out}`)
