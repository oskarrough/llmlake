#!/usr/bin/env bun
// Two-way merge data/sessions/ with a shared library folder using rsync.
// Reports per-direction added/removed session (.jsonl) counts.
import { $ } from 'bun'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: sync <dest>')
  process.exit(1)
}
const dest = arg.replace(/^~(?=$|\/)/, homedir())
const src = join(import.meta.dir, 'data/sessions')

await $`mkdir -p ${dest}`

const destBefore = listSessions(dest)
await $`rsync -a ${src}/ ${dest}/`
console.log(`synced ${src}/ → ${dest}/  ${formatDiff(destBefore, listSessions(dest))}`)

const srcBefore = listSessions(src)
await $`rsync -a ${dest}/ ${src}/`
console.log(`synced ${dest}/ → ${src}/  ${formatDiff(srcBefore, listSessions(src))}`)
