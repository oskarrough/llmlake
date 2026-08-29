#!/usr/bin/env bun
// Build parquet for every collected JSONL session under data/sessions/. Skips files whose parquet is newer than the source; a global stamp records the transformation-code hash and forces a full rebuild when it changes; orphaned parquet is pruned after.
// Each worker owns one long-lived duckdb process + temp JSON file: parse → write JSON → COPY via stdin → wait for a `.print` sentinel on stdout; reusing the process amortizes startup.
import { createHash } from 'node:crypto'
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

// Hash the files that decide what rows a source produces; when their hash differs from the stamp left by the last successful build, ignore source mtimes and rebuild everything. A missing stamp (first build) is stale too.
const stampPath = join(parquetRoot, 'build.stamp')
const codeHash = await (async () => {
  const hash = createHash('sha256')
  for (const rel of [
    'build.ts',
    'parse-session.ts',
    'pricing.ts',
    'litellm-pricing.json',
    'lib/build-session.ts',
  ]) {
    hash.update(rel)
    hash.update(new Uint8Array(await Bun.file(join(import.meta.dir, rel)).arrayBuffer()))
  }
  return hash.digest('hex')
})()
const codeStale =
  (
    await Bun.file(stampPath)
      .text()
      .catch(() => '')
  ).trim() !== codeHash

async function needsRebuild(src: string, agent: Agent): Promise<boolean> {
  if (codeStale) return true
  const [srcM, outM] = await Promise.all([fileMtime(src), fileMtime(outPathFor(agent, src))])
  return !(srcM != null && outM != null && outM >= srcM)
}

// Claude writes the same usage record into multiple files (resumed/subagent/sidechain); this registers one winner per usage key so the build counts each call once. Skipped when no claude file is stale.
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
    // A single quote in a path closes the SQL literal early and hangs the marker read forever; double them (Dropbox "conflicted copy" names are the usual source).
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
    // duckdb prints the marker even after a failed COPY (the error went to stderr); verify the file landed.
    if (!(await Bun.file(out).exists())) throw new Error(`duckdb failed to write ${out}`)
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

if (codeStale) console.log(dim('transformation code changed — rebuilding all outputs'))

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
          // Not a parse failure — a file under an unrecognized top-level dir; tracked separately so it can't masquerade as a parse error.
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
        // Raw is authoritative: drop any stale output first so a failed COPY can't leave an old parquet behind and look successful. Only ENOENT is ignorable; e.g. an unwritable dir must fail the build so the marker isn't advanced over a stale output.
        await unlink(out).catch((e) => {
          if ((e as { code?: string }).code !== 'ENOENT') throw e
        })
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

await mkdir(parquetRoot, { recursive: true })
// data/sessions is the source of truth: delete parquet with no matching source jsonl (deleted or renamed source, or an unknown agent dir). An empty scan may mean an unavailable archive — keep the cache.
const expected = new Set<string>()
for (const src of files) {
  const agent = relative(root, src).split(/[\\/]/)[0]
  if (agent && (AGENTS as readonly string[]).includes(agent))
    expected.add(outPathFor(agent as Agent, src))
}
let pruned = 0
if (files.length) {
  for await (const path of new Bun.Glob('**/*.parquet').scan({
    cwd: parquetRoot,
    absolute: true,
    onlyFiles: true,
  })) {
    if (!expected.has(path)) {
      await unlink(path)
      pruned++
    }
  }
} else {
  console.warn('warning: no source sessions found — keeping existing parquet')
}
// Advance the stamp only after a fully successful run so a failed build is retried in full next time.
if (!errors) await Bun.write(stampPath, codeHash)

console.log(bold('build'))
console.log(
  `  ${plural(built, 'file')} built  ${dim(
    [
      `${skipped} unchanged`,
      `${pruned} pruned`,
      ...(errors ? [`${errors} failed`] : []),
      ...(unknown ? [`${unknown} ignored`] : []),
      `${files.length} total`,
    ].join(' · '),
  )}`,
)
if (errors) process.exit(1)
