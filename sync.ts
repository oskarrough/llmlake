#!/usr/bin/env bun
// Merge session transcripts with a shared library using rsync.
import { $ } from 'bun'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { diffCounts, listSessions } from './lib/diff.ts'
import { expandHome } from './lib/collect.ts'
import { normalizeSessionTree } from './lib/normalize-sessions.ts'
import { bold, formatDelta, renderRows, shortPath } from './lib/ui.ts'

const [arg, ...flags] = process.argv.slice(2)
const strict = flags.includes('--strict')
const pushFromIndex = flags.indexOf('--push-from')
const pushFrom = pushFromIndex === -1 ? undefined : flags[pushFromIndex + 1]
if (!arg || (pushFromIndex !== -1 && !pushFrom)) {
  console.error('usage: sync <dest> [--strict] [--push-from <dir>]')
  process.exit(1)
}

const dest = expandHome(arg).replace(/\/+$/, '')
const src = pushFrom
  ? expandHome(pushFrom).replace(/\/+$/, '')
  : join(import.meta.dir, 'data/sessions')

// Dropbox can leave files unhydrated or move them while rsync reads. Keep the
// interactive warning, and let automation opt into a nonzero exit to retry.
const PARTIAL = new Set([23, 24, 30])

async function move(label: string, from: string, to: string) {
  const before = listSessions(to)
  const files: string[] = []
  let protectedFiles = 0
  for (const file of listSessions(from)) {
    const source = lstatSync(join(from, file), { throwIfNoEntry: false })
    if (!source?.isFile()) continue

    const target = before.has(file)
      ? lstatSync(join(to, file), { throwIfNoEntry: false })
      : undefined
    if (target?.isFile() && source.size < target.size) {
      protectedFiles++
      continue
    }
    files.push(file)
  }

  const manifest = new Blob(files.map((file) => file + '\0'))
  const { exitCode, stderr } =
    await $`rsync -a --from0 --files-from=- ${from}/ ${to}/ < ${manifest}`.nothrow().quiet()
  if (exitCode !== 0 && !PARTIAL.has(exitCode)) {
    throw new Error(stderr.toString().trim() || `rsync exited with ${exitCode}`)
  }

  const after = listSessions(to)
  const { added, removed } = diffCounts(before, after)
  return {
    label,
    delta: formatDelta(added, removed),
    total: after.size,
    detail: `${shortPath(from)} → ${shortPath(to)}`,
    protectedFiles,
    partial: exitCode !== 0,
  }
}

await $`mkdir -p ${dest}`
await normalizeSessionTree(src)
await normalizeSessionTree(dest)

const moves = [await move('push', src, dest)]
if (!pushFrom) moves.push(await move('pull', dest, src))

console.log(bold(`sync ${shortPath(dest)}`))
for (const [i, line] of renderRows(moves).entries()) {
  console.log(line)
  const move = moves[i]!
  if (move.protectedFiles) console.log(`  kept ${move.protectedFiles} longer destination files`)
  if (move.partial) console.log('  warning: incomplete transfer; next run will retry')
}
if (strict && moves.some((move) => move.partial)) process.exitCode = 1
