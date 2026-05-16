#!/usr/bin/env bun
// Pi stores saved session logs as JSONL files under
//   ~/.pi/agent/sessions/
// organized by working directory. Sync them into data/sessions/pi/.
//
// Source schema (fill in from a real session file):
//   ...
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'

const src = join(homedir(), '.pi/agent/sessions/')
const dst = join(import.meta.dir, 'data/sessions/pi/')

if (!existsSync(src)) {
  console.warn(`skipped pi: ${src} does not exist`)
  process.exit(0)
}

const before = listSessions(dst)
await $`mkdir -p ${dst}`
await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
console.log(`synced ${src} → ${dst}  ${formatDiff(before, listSessions(dst))}`)
