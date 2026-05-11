#!/usr/bin/env bun
// Claude Code stores raw session transcripts as JSONL files under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Sync them into data/sessions/claude/, preserving the per-cwd directory structure.
//
// Source schema (one JSON object per line; verify against a real file):
//   type           "user" | "assistant" | "system" | "summary" | ...
//   uuid           event id
//   parentUuid     previous event in the chain
//   sessionId      session id (matches filename)
//   timestamp      ISO 8601
//   cwd            working directory the session ran in
//   message        { role, content[], model?, usage? }
//   message.usage  { input_tokens, output_tokens,
//                    cache_read_input_tokens, cache_creation_input_tokens }
//   toolUseResult  present on tool_result events
import { $ } from 'bun'
import { homedir } from 'node:os'
import { join } from 'node:path'

const src = join(homedir(), '.claude/projects/')
const dst = join(import.meta.dir, 'data/sessions/claude/')

await $`mkdir -p ${dst}`
await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
console.log(`synced ${src} → ${dst}`)
