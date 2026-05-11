#!/usr/bin/env bun
// Codex CLI stores raw session transcripts as JSONL files under
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
// Sync them into data/sessions/codex/, preserving the date directory structure.
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

const src = join(homedir(), '.codex/sessions/')
const dst = join(import.meta.dir, 'data/sessions/codex/')

if (!existsSync(src)) {
	console.warn(`skipped codex: ${src} does not exist`)
	process.exit(0)
}

await $`mkdir -p ${dst}`
await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
console.log(`synced ${src} -> ${dst}`)
