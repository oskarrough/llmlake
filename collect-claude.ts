#!/usr/bin/env bun
// Claude Code stores raw session transcripts as JSONL files under
//   <root>/projects/<encoded-cwd>/<session-id>.jsonl
// Roots: CLAUDE_CONFIG_DIR (comma-separated, each <root>/projects), or by default
//   ~/.claude/projects and ~/.config/claude/projects.
// Sync into data/sessions/claude/ (primary ~/.claude at lake root; extras under _config/, _env/).
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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatDiff, listSessions } from './lib/diff.ts'
import { expandHome } from './lib/expand-home.ts'

function projectsDir(root: string): string {
  const normalized = root.replace(/\\/g, '/')
  return normalized.endsWith('/projects') ? root : join(root, 'projects')
}

function claudeSources(): { src: string; dstSuffix: string }[] {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (env) {
    return env.split(',').flatMap((part, i) => {
      const raw = expandHome(part.trim())
      if (!raw) return []
      return [{ src: join(projectsDir(raw), '/'), dstSuffix: `_env/${i}` }]
    })
  }
  return [
    { src: join(homedir(), '.claude/projects/'), dstSuffix: '' },
    { src: join(homedir(), '.config/claude/projects/'), dstSuffix: '_config' },
  ]
}

const dstRoot = join(import.meta.dir, 'data/sessions/claude/')
const sources = claudeSources()

let before = listSessions(dstRoot)
let synced = 0

for (const { src, dstSuffix } of sources) {
  if (!existsSync(src)) {
    console.warn(`skipped claude: ${src} does not exist`)
    continue
  }
  const dst = dstSuffix ? join(dstRoot, dstSuffix, '/') : dstRoot
  await $`mkdir -p ${dst}`
  await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
  synced++
}

if (synced === 0) process.exit(0)

console.log(`synced claude -> ${dstRoot}  ${formatDiff(before, listSessions(dstRoot))}`)
