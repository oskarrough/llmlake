#!/usr/bin/env bun
// Two-way merge data/sessions/ with a shared library folder using rsync.
// Reports per-direction added/removed session (.jsonl) counts.
import { $ } from 'bun'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'
import { normalizeSessionTree } from './lib/normalize-sessions.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: sync <dest>')
  process.exit(1)
}
const dest = arg.replace(/^~(?=$|\/)/, homedir())
const src = join(import.meta.dir, 'data/sessions')

// rsync exit 24 = "some source files vanished before transfer" — benign, and
// common when syncing a live Dropbox folder that reshuffles files underneath us.
async function rsync(from: string, to: string) {
  const { exitCode, stderr } = await $`rsync -a ${from}/ ${to}/`.nothrow().quiet()
  if (exitCode !== 0 && exitCode !== 24) throw new Error(stderr.toString())
}

await $`mkdir -p ${dest}`

// Canonicalize both trees first so case/conflict variants don't ping-pong
// across the round-trip and prevent convergence (Dropbox is case-insensitive).
await normalizeSessionTree(src)
await normalizeSessionTree(dest)

const destBefore = listSessions(dest)
await rsync(src, dest)
console.log(`synced ${src}/ → ${dest}/  ${formatDiff(destBefore, listSessions(dest))}`)

const srcBefore = listSessions(src)
await rsync(dest, src)
console.log(`synced ${dest}/ → ${src}/  ${formatDiff(srcBefore, listSessions(src))}`)
