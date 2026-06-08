#!/usr/bin/env bun
// Claude Code stores transcripts under <root>/projects/<encoded-cwd>/<session-id>.jsonl.
// Roots: CLAUDE_CONFIG_DIR (comma-separated, each <root>/projects), else
// ~/.claude/projects and ~/.config/claude/projects.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, sessionsDir } from './lib/collect.ts'
import { expandHome } from './lib/expand-home.ts'

function projectsDir(root: string): string {
  return root.replace(/\\/g, '/').endsWith('/projects') ? root : join(root, 'projects')
}

const dstRoot = sessionsDir('claude')
const env = process.env.CLAUDE_CONFIG_DIR?.trim()
const sources = env
  ? env.split(',').flatMap((part, i) => {
      const raw = expandHome(part.trim())
      return raw ? [{ src: join(projectsDir(raw), '/'), dst: join(dstRoot, `_env/${i}`, '/') }] : []
    })
  : [
      { src: join(homedir(), '.claude/projects/') },
      { src: join(homedir(), '.config/claude/projects/'), dst: join(dstRoot, '_config', '/') },
    ]

await collect('claude', dstRoot, sources)
