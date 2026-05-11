#!/usr/bin/env bun
// Build parquet for every collected JSONL session under data/sessions/.
// Skips files whose output parquet is newer than the source jsonl, so reruns
// only touch sessions that changed. Each changed file is parsed in-process and
// written via its own short-lived duckdb COPY, run across a worker pool.
import { basename, dirname, join, relative } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import {
  AGENTS,
  colsSql,
  newState,
  parseLine,
  type Agent,
  type ParseContext,
  type Row,
} from './parse-session.ts'

const root = join(import.meta.dir, 'data/sessions')
const parquetRoot = join(import.meta.dir, 'data/parquet')

async function fileMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

function outPathFor(agent: Agent, src: string): string {
  return join(parquetRoot, `agent=${agent}`, basename(src).replace(/\.jsonl$/, '.parquet'))
}

async function buildOne(src: string): Promise<'built' | 'skipped' | 'error'> {
  const rel = relative(root, src)
  const agent = rel.split(/[\\/]/)[0] as Agent
  if (!AGENTS.includes(agent)) return 'error'

  const out = outPathFor(agent, src)
  const [srcM, outM] = await Promise.all([fileMtime(src), fileMtime(out)])
  if (srcM != null && outM != null && outM >= srcM) return 'skipped'

  const ctx: ParseContext = { agent, sourceFile: rel, state: newState() }
  const rows: Row[] = []
  const lines = (await Bun.file(src).text()).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line) rows.push(parseLine(line, i + 1, ctx))
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
      stdout: 'ignore',
      stderr: 'inherit',
    },
  )
  if ((await proc.exited) !== 0) return 'error'
  return 'built'
}

const files: string[] = []
const glob = new Bun.Glob('**/*.jsonl')
for await (const f of glob.scan({ cwd: root, absolute: true })) files.push(f)

const envC = process.env.BUILD_CONCURRENCY ? Number(process.env.BUILD_CONCURRENCY) : null
const concurrency =
  envC && envC > 0 ? envC : Math.max(2, Math.min(16, navigator.hardwareConcurrency ?? 4))
let built = 0
let skipped = 0
let errors = 0
let cursor = 0

async function worker() {
  while (true) {
    const i = cursor++
    if (i >= files.length) return
    const f = files[i]
    if (!f) return
    const result = await buildOne(f)
    if (result === 'built') built++
    else if (result === 'skipped') skipped++
    else errors++
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

console.log(
  `built ${built}, skipped ${skipped}${errors ? `, errors ${errors}` : ''} (of ${files.length})`,
)
if (errors) process.exit(1)
