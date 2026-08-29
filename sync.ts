#!/usr/bin/env bun
// Two-way merge data/sessions/ with a shared library folder using rsync; reports per-direction added/removed session counts.
import { $ } from 'bun'
import { join } from 'node:path'
import { diffCounts, listSessions } from './lib/diff.ts'
import { expandHome } from './lib/collect.ts'
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

// Benign rsync exit codes for a live Dropbox folder (24 source vanished mid-transfer, 23 partial, 30 hydration timeout): rsync copied everything readable and the next run picks up stragglers, so warn instead of throwing. One pass only — retrying re-hydrates hundreds of online-only files and pegs Dropbox.
const BENIGN = new Set([23, 24, 30])

async function rsync(from: string, to: string): Promise<string | null> {
  const { exitCode, stderr } = await $`rsync -a ${from}/ ${to}/`.nothrow().quiet()
  if (exitCode === 0) return null
  if (!BENIGN.has(exitCode)) throw new Error(stderr.toString())
  return 'some files not downloaded by Dropbox yet; next run picks them up'
}

await $`mkdir -p ${dest}`

// Canonicalize both trees first so case/conflict variants don't ping-pong across the round-trip (Dropbox is case-insensitive).
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
