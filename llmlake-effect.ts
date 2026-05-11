#!/usr/bin/env bun

// llmlake-effect.ts — Effect.ts port of `collect` + `build` in one file.
// Run: bun llmlake-effect.ts <collect|build>
// Parses, errors, and concurrency are expressed with Effect so we can
// feel out whether it's a nicer fit for a local data pipeline than the
// plain Bun scripts in collect.ts / build.ts.

import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Cause, Console, Data, Effect, Pool, Schema } from 'effect'
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

const validateRow = Schema.validateSync(RowSchema)

// ─── Errors ──────────────────────────────────────────────────────────────────
// Only one tagged error here — the rest go through the one-arg `tryPromise`
// form as `UnknownException`, since `buildOne` handles them uniformly. 
class RsyncFailed extends Data.TaggedError('RsyncFailed')<{
  readonly agent: Agent
  readonly src: string
  readonly cause: unknown
}> {}

class BuildHadErrors extends Data.TaggedError('BuildHadErrors')<{
  readonly count: number
}> {}

// ─── Paths ───────────────────────────────────────────────────────────────────

const PATHS = {
  sessionsRoot: join(import.meta.dir, 'data/sessions'),
  parquetRoot: join(import.meta.dir, 'data/parquet'),
}

// ─── Collect ─────────────────────────────────────────────────────────────────

const SOURCES: ReadonlyArray<{ readonly agent: Agent; readonly src: string }> = [
  { agent: 'claude', src: join(homedir(), '.claude/projects/') },
  { agent: 'codex', src: join(homedir(), '.codex/sessions/') },
  { agent: 'pi', src: join(homedir(), '.pi/agent/sessions/') },
  { agent: 'hermes', src: join(homedir(), '.hermes/sessions/') },
]

const collectOne = (s: { agent: Agent; src: string }) =>
  Effect.gen(function* () {
    const dst = join(PATHS.sessionsRoot, `${s.agent}/`)
    if (!existsSync(s.src)) {
      yield* Console.warn(`skipped ${s.agent}: ${s.src} does not exist`)
      return { agent: s.agent, status: 'skipped' as const }
    }
    yield* Effect.tryPromise({
      try: async () => {
        await $`mkdir -p ${dst}`
        await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${s.src} ${dst}`
      },
      catch: (cause) => new RsyncFailed({ agent: s.agent, src: s.src, cause }),
    })
    yield* Console.log(`synced ${s.src} → ${dst}`)
    return { agent: s.agent, status: 'synced' as const }
  }).pipe(
    Effect.catchTag('RsyncFailed', (err) =>
      Effect.gen(function* () {
        yield* Console.error(`failed ${err.agent}:`, err.cause)
        return { agent: err.agent, status: 'error' as const }
      }),
    ),
  )

const collect = Effect.all(SOURCES.map(collectOne), { concurrency: 'unbounded' })

// ─── DuckdbWorker (stateful; lifecycle managed by Effect.Pool) ───────────────

class DuckdbWorker {
  private proc = Bun.spawn(['duckdb'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  private reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
  private tmpJson: string
  private decoder = new TextDecoder()
  private buffer = ''
  private seq = 0

  constructor(id: number) {
    this.tmpJson = join(tmpdir(), `llmlake-effect-${process.pid}-${id}.json`)
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

let workerIdSeq = 0
const acquireWorker = Effect.acquireRelease(
  Effect.try(() => new DuckdbWorker(workerIdSeq++)),
  (w) => Effect.promise(() => w.close()),
)

// ─── Build ───────────────────────────────────────────────────────────────────

const tryStatMtime = (path: string) =>
  Effect.tryPromise(() => stat(path).then((s) => s.mtimeMs)).pipe(
    Effect.orElseSucceed<number | null>(() => null),
  )

const listJsonl = (root: string) =>
  Effect.tryPromise(async () => {
    const files: string[] = []
    for await (const f of new Bun.Glob('**/*.jsonl').scan({ cwd: root, absolute: true })) {
      files.push(f)
    }
    return files
  })

const parseFile = (src: string, agent: Agent) =>
  Effect.tryPromise(async () => {
    const ctx: ParseContext = {
      agent,
      sourceFile: relative(PATHS.sessionsRoot, src),
      state: newState(),
    }
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
  })

const outPathFor = (agent: Agent, src: string) => {
  const rel = relative(join(PATHS.sessionsRoot, agent), src).replace(/\.jsonl$/, '.parquet')
  return join(PATHS.parquetRoot, `agent=${agent}`, rel)
}

type Outcome = 'built' | 'skipped' | 'error'

const buildOne = (src: string, pool: Pool.Pool<DuckdbWorker, Cause.UnknownException>) =>
  Effect.gen(function* () {
    const rel = relative(PATHS.sessionsRoot, src)
    const agent = rel.split(/[\\/]/)[0] as Agent
    if (!AGENTS.includes(agent)) {
      yield* Console.warn(`unknown agent for ${rel}`)
      return 'error' as Outcome
    }
    const out = outPathFor(agent, src)
    const [srcM, outM] = yield* Effect.all([tryStatMtime(src), tryStatMtime(out)], {
      concurrency: 'unbounded',
    })
    if (srcM != null && outM != null && outM >= srcM) return 'skipped' as Outcome

    const rows = yield* parseFile(src, agent)
    yield* Effect.tryPromise(() => mkdir(dirname(out), { recursive: true }))

    yield* Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* pool
        yield* Effect.tryPromise(() => worker.copy(rows, out))
      }),
    )
    return 'built' as Outcome
  }).pipe(
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        yield* Console.error(`error on ${src}:`, err)
        return 'error' as Outcome
      }),
    ),
  )

const build = Effect.gen(function* () {
  const files = yield* listJsonl(PATHS.sessionsRoot)
  const envC = Number(process.env.BUILD_CONCURRENCY) || 0
  const concurrency =
    envC > 0 ? envC : Math.max(2, Math.min(16, navigator.hardwareConcurrency ?? 4))

  const outcomes = yield* Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* Pool.make({ acquire: acquireWorker, size: concurrency })
      return yield* Effect.forEach(files, (f) => buildOne(f, pool), { concurrency })
    }),
  )

  const counts: Record<Outcome, number> = { built: 0, skipped: 0, error: 0 }
  for (const o of outcomes) counts[o]++
  yield* Console.log(
    `built ${counts.built}, skipped ${counts.skipped}` +
      `${counts.error ? `, errors ${counts.error}` : ''} (of ${files.length})`,
  )
  if (counts.error) return yield* new BuildHadErrors({ count: counts.error })
})

const cmd = process.argv[2]
if (cmd !== 'collect' && cmd !== 'build') {
  console.error('usage: bun llmlake-effect.ts <collect|build>')
  process.exit(1)
}

const program = cmd === 'collect' ? collect.pipe(Effect.asVoid) : build

Effect.runPromise(program).catch((e) => {
  if (e?._tag !== 'BuildHadErrors') console.error(e)
  process.exit(1)
})
