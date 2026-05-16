#!/usr/bin/env bun
// Codex CLI stores raw session transcripts as JSONL files under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
//   $CODEX_HOME/archived_sessions/*.jsonl (flat)
// Sync them into data/sessions/codex/, preserving layout per source root.
//
// Source schema (one JSON object per line; verify against a real file):
//   timestamp      ISO 8601 event timestamp
//   type           "session_meta" | "event_msg" | "response_item" | ...
//   payload        event-specific payload
//   payload.id     session id on session_meta events
//   payload.cwd    working directory on session_meta events
//   payload.model  model name on selected response/request events
//
// Quirks to handle in build-one (not here):
//   - session_id is only on session_meta; derive from filename for other rows.
//   - cwd is only on session_meta; forward-fill onto later rows.
//   - model lives in turn_context rows, not on message rows; forward-fill.
//   - role=developer should normalize to "system".
//   - token usage is its own event_msg (token_count), not attached to messages.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'
import { expandHome } from './lib/expand-home.ts'

function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim()
  if (raw) return expandHome(raw)
  return join(homedir(), '.codex')
}

const home = codexHome()
const dst = join(import.meta.dir, 'data/sessions/codex/')

const sources: { src: string; dst: string }[] = [
  { src: join(home, 'sessions/'), dst },
  { src: join(home, 'archived_sessions/'), dst: join(dst, 'archived_sessions/') },
]

let before = listSessions(dst)
let synced = 0

for (const { src, dst: target } of sources) {
  if (!existsSync(src)) {
    console.warn(`skipped codex: ${src} does not exist`)
    continue
  }
  await $`mkdir -p ${target}`
  await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${target}`
  synced++
}

if (synced === 0) process.exit(0)

console.log(`synced codex (${home}) -> ${dst}  ${formatDiff(before, listSessions(dst))}`)
