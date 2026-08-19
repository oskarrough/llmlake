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
import {
  AGENTS,
  buildCodexSessionIndex,
  colsSql,
  newClaudeCrossFileRegistry,
  populateClaudeCrossFile,
  type Agent,
  type Row,
} from './parse-session.ts'
import { parseSessionRows } from './lib/build-session.ts'
import { ensureDuckdb } from './lib/duck.ts'
import { bold, dim, plural } from './lib/ui.ts'

ensureDuckdb()

const root = join(import.meta.dir, 'data/sessions')
const parquetRoot = join(import.meta.dir, 'data/parquet')
const codexSessionIndex = await buildCodexSessionIndex(root)
const claudeCrossFile = newClaudeCrossFileRegistry()

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

async function needsRebuild(src: string, agent: Agent): Promise<boolean> {
  const [srcM, outM] = await Promise.all([fileMtime(src), fileMtime(outPathFor(agent, src))])
  return !(srcM != null && outM != null && outM >= srcM)
}

// Claude writes the same usage record into multiple files (resumed sessions,
// subagents, sidechains); this registers one winner per usage key so the build
// counts each call once. Skipped entirely when no claude file is stale.
await populateClaudeCrossFile(claudeCrossFile, root, codexSessionIndex, (src) =>
  needsRebuild(src, 'claude'),
)

async function parseFile(src: string, agent: Agent): Promise<Row[]> {
  return parseSessionRows({
    src,
    agent,
    sessionsRoot: root,
    codexSessionIndex,
    ...(agent === 'claude' ? { claudeCrossFile } : {}),
  })
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
    // Paths are interpolated into SQL string literals; any single quote closes
    // the literal early, so duckdb never reaches `.print` and the marker read
    // below blocks forever. Double them. (Dropbox "conflicted copy" paths like
    // `…(r's conflicted copy).parquet` are the usual source of an apostrophe.)
    const sqlStr = (s: string) => s.replaceAll("'", "''")
    await this.proc.stdin.write(
      `COPY (SELECT * FROM read_json('${sqlStr(this.tmpJson)}', format='newline_delimited', columns={${colsSql}})) ` +
        `TO '${sqlStr(out)}' (FORMAT PARQUET, COMPRESSION ZSTD);\n.print ${marker}\n`,
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
let unknown = 0
const unknownDirs = new Set<string>()
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
          // Not a parse failure — a file under an unrecognized top-level dir
          // (e.g. a stray `sessions/` folder from a misconfigured sync). Track
          // these separately so they can't masquerade as parse errors.
          unknownDirs.add(agent)
          unknown++
          continue
        }
        if (!(await needsRebuild(src, agent))) {
          skipped++
          continue
        }
        const out = outPathFor(agent, src)
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

if (unknown) {
  console.warn(
    `warning: ignored ${unknown} files under unrecognized top-level dir(s): ${[...unknownDirs].join(
      ', ',
    )} — expected one of ${AGENTS.join(', ')}`,
  )
}

console.log(bold('build'))
console.log(
  `  ${plural(built, 'file')} built  ${dim(
    [
      `${skipped} unchanged`,
      ...(errors ? [`${errors} failed`] : []),
      ...(unknown ? [`${unknown} ignored`] : []),
      `${files.length} total`,
    ].join(' · '),
  )}`,
)
if (errors) process.exit(1)
