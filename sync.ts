#!/usr/bin/env bun
// Two-way merge data/sessions/ with a shared library folder using rsync.
// Reports per-direction added/removed session (.jsonl) counts.
import { $ } from 'bun'
import { join } from 'node:path'
import { diffCounts, listSessions } from './lib/diff.ts'
import { expandHome } from './lib/expand-home.ts'
import { normalizeSessionTree } from './lib/normalize-sessions.ts'
import { bold, formatDelta, renderRows, shortPath } from './lib/ui.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: sync <dest>')
  process.exit(1)
}
// Trailing slashes are stripped so `sync ~/dir/` doesn't print `~/dir//`.
const dest = expandHome(arg).replace(/\/+$/, '')
const src = join(import.meta.dir, 'data/sessions')

// Some rsync exit codes are benign for a live Dropbox folder and must NOT abort
// the sync — especially the pull direction, where reading a cloud file forces
// Dropbox to download it:
//   24 = a source file vanished mid-transfer (Dropbox reshuffled underneath us)
//   23 = partial transfer — rsync copied everything it could and flagged the rest
//   30 = timeout — an mmap read of an online-only placeholder timed out hydrating
// In every case rsync still transferred every file it could read; only the
// not-yet-hydrated stragglers are skipped, and the next run picks them up once
// Dropbox has materialized them in the background. We warn instead of throwing.
//
// One pass only — no retry loop. Retrying re-walks the whole tree and re-triggers
// hydration of hundreds of online-only files, which pegs Dropbox and the machine.
const BENIGN = new Set([23, 24, 30])

async function rsync(from: string, to: string): Promise<string | null> {
  const { exitCode, stderr } = await $`rsync -a ${from}/ ${to}/`.nothrow().quiet()
  if (exitCode === 0) return null
  if (!BENIGN.has(exitCode)) throw new Error(stderr.toString())
  return 'some files not downloaded by Dropbox yet; next run picks them up'
}

await $`mkdir -p ${dest}`

// Canonicalize both trees first so case/conflict variants don't ping-pong
// across the round-trip and prevent convergence (Dropbox is case-insensitive).
await normalizeSessionTree(src)
await normalizeSessionTree(dest)

async function move(label: string, from: string, to: string) {
  const before = listSessions(to)
  const warning = await rsync(from, to)
  const after = listSessions(to)
  const { added, removed } = diffCounts(before, after)
  return {
    label,
    delta: formatDelta(added, removed),
    total: after.size,
    detail: `${shortPath(from)} → ${shortPath(to)}`,
    warning,
  }
}

const moves = [await move('push', src, dest), await move('pull', dest, src)]

console.log(bold(`sync ${shortPath(dest)}`))
const lines = renderRows(moves)
for (const [i, line] of lines.entries()) {
  console.log(line)
  const warning = moves[i]?.warning
  if (warning) console.log(`  warning: ${warning}`)
}
