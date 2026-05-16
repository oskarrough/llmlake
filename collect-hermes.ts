#!/usr/bin/env bun
// Hermes Agent stores raw session transcripts as JSONL files under
//   ~/.hermes/sessions/YYYYMMDD_HHMMSS_<hash>.jsonl
// Sync them into data/sessions/hermes/.
//
// Source schema (one JSON object per line):
//   session_meta: { role:"session_meta", tools:[], model, platform, timestamp }
//   user:        { role:"user", content:str, timestamp }
//   assistant:   { role:"assistant", content:str?, reasoning?, finish_reason?,
//                   tool_calls:[{ id, call_id, type:"function",
//                     function:{ name, arguments } }], timestamp }
//   tool:        { role:"tool", name, content:str (JSON), tool_call_id, timestamp }
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'

const src = join(homedir(), '.hermes/sessions/')
const dst = join(import.meta.dir, 'data/sessions/hermes/')

if (!existsSync(src)) {
  console.warn(`skipped hermes: ${src} does not exist`)
  process.exit(0)
}

const before = listSessions(dst)
await $`mkdir -p ${dst}`
await $`rsync -a --include='*.jsonl' --exclude='*' ${src} ${dst}`
console.log(`synced ${src} → ${dst}  ${formatDiff(before, listSessions(dst))}`)
