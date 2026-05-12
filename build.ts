#!/usr/bin/env bun
// Build parquet for every collected JSONL session under data/sessions/.
// Skips files whose output parquet is newer than the source jsonl.
//
// Each concurrent worker owns one long-lived `duckdb` process and one temp
// JSON file. For each source: parse → write temp JSON → send `COPY ... TO ...`
// over duckdb's stdin → wait for a `.print <marker>` sentinel on stdout.
// Reusing the duckdb process amortizes its startup across all files in a run.
import { dirname, join, relative } from 'node:path'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Schema } from 'effect'
import {
  AGENTS,
  colsSql,
  newState,
  parseLine,
  RowSchema,
  type Agent,
  type ParseContext,
  type Row,
} from './parse-session.ts'

try {
  Bun.spawnSync(['duckdb', '--version'])
} catch {
  console.error('duckdb not found. Install it from https://duckdb.org/docs/installation/')
  process.exit(1)
}

// Validate each row against RowSchema at parse time so a bad row is caught
// here (with file:line context) rather than as a cryptic duckdb COPY failure.
const validateRow = Schema.validateSync(RowSchema)

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
  const rel = relative(join(root, agent), src).replace(/\.jsonl$/, '.parquet')
  return join(parquetRoot, `agent=${agent}`, rel)
}

async function parseFile(src: string, agent: Agent): Promise<Row[]> {
  const ctx: ParseContext = { agent, sourceFile: relative(root, src), state: newState() }
  const rows: Row[] = []
  const lines = (await Bun.file(src).text()).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    for (const row of parseLine(line, i + 1, ctx)) {
      try {
        rows.push(validateRow(row))
      } catch (cause) {
        throw new Error(
          `row validation failed at ${ctx.sourceFile}:${i + 1}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        )
      }
    }
  }
  return rows
}

class DuckdbWorker {
  private proc = Bun.spawn(['duckdb'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  private reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
  private tmpJson: string
  private decoder = new TextDecoder()
  private buffer = ''
  private seq = 0

  constructor(id: number) {
    this.tmpJson = join(tmpdir(), `llmlake-${process.pid}-${id}.json`)
  }

  async copy(rows: Row[], out: string): Promise<void> {
    await Bun.write(this.tmpJson, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const marker = `__llmlake_done_${++this.seq}__`
    await this.proc.stdin.write(
      `COPY (SELECT * FROM read_json('${this.tmpJson}', format='newline_delimited', columns={${colsSql}})) ` +
        `TO '${out}' (FORMAT PARQUET, COMPRESSION ZSTD);\n.print ${marker}\n`,
    )
    await this.proc.stdin.flush()
    while (!this.buffer.includes(marker)) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('duckdb exited before marker')
      this.buffer += this.decoder.decode(value, { stream: true })
    }
    this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
  }

  async close(): Promise<void> {
    await this.proc.stdin.end()
    await this.proc.exited
    await unlink(this.tmpJson).catch(() => {})
  }
}

const files: string[] = []
for await (const f of new Bun.Glob('**/*.jsonl').scan({ cwd: root, absolute: true })) files.push(f)

const envC = process.env.BUILD_CONCURRENCY ? Number(process.env.BUILD_CONCURRENCY) : null
const concurrency =
  envC && envC > 0 ? envC : Math.max(2, Math.min(16, navigator.hardwareConcurrency ?? 4))

let built = 0
let skipped = 0
let errors = 0
let cursor = 0

async function workerLoop(id: number) {
  let worker: DuckdbWorker | undefined
  try {
    while (true) {
      const i = cursor++
      if (i >= files.length) return
      const src = files[i]
      if (!src) return
      try {
        const rel = relative(root, src)
        const agent = rel.split(/[\\/]/)[0] as Agent
        if (!AGENTS.includes(agent)) {
          errors++
          continue
        }
        const out = outPathFor(agent, src)
        const [srcM, outM] = await Promise.all([fileMtime(src), fileMtime(out)])
        if (srcM != null && outM != null && outM >= srcM) {
          skipped++
          continue
        }
        const rows = await parseFile(src, agent)
        await mkdir(dirname(out), { recursive: true })
        worker ??= new DuckdbWorker(id)
        await worker.copy(rows, out)
        built++
      } catch (e) {
        errors++
        console.error(`error on ${src}:`, e)
      }
    }
  } finally {
    await worker?.close()
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => workerLoop(i)))

console.log(
  `built ${built}, skipped ${skipped}${errors ? `, errors ${errors}` : ''} (of ${files.length})`,
)
if (errors) process.exit(1)
