#!/usr/bin/env bun
// Claude Code stores transcripts under <root>/projects/<encoded-cwd>/<session-id>.jsonl.
// Roots: CLAUDE_CONFIG_DIR (comma-separated, each <root>/projects), else
// ~/.claude/projects and ~/.config/claude/projects.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'
import { expandHome } from './lib/expand-home.ts'
import { shortPath } from './lib/ui.ts'

function projectsDir(root: string): string {
  return root.replace(/\\/g, '/').endsWith('/projects') ? root : join(root, 'projects')
}

export function collectClaude(): Promise<CollectResult> {
  const dstRoot = sessionsDir('claude')
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  const sources = env
    ? env.split(',').flatMap((part, i) => {
        const raw = expandHome(part.trim())
        if (!raw) return []
        const src = join(projectsDir(raw), '/')
        return [{ src, dst: join(dstRoot, `_env/${i}`, '/'), label: shortPath(src) }]
      })
    : [
        { src: join(homedir(), '.claude/projects/'), label: '~/.claude' },
        {
          src: join(homedir(), '.config/claude/projects/'),
          dst: join(dstRoot, '_config', '/'),
          label: '~/.config/claude',
        },
      ]
  return collect('claude', dstRoot, sources)
}

if (import.meta.main) console.log(formatResult(await collectClaude()))
