#!/usr/bin/env bun
// Codex CLI stores transcripts under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
// and $CODEX_HOME/archived_sessions/*.jsonl. CODEX_HOME defaults to ~/.codex.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'
import { expandHome } from './lib/expand-home.ts'
import { shortPath } from './lib/ui.ts'

export function collectCodex(): Promise<CollectResult> {
  const home = expandHome(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
  const dst = sessionsDir('codex')
  return collect(`codex`, dst, [
    { src: join(home, 'sessions/'), label: shortPath(home) },
    {
      src: join(home, 'archived_sessions/'),
      dst: join(dst, 'archived_sessions/'),
      label: shortPath(home),
    },
  ])
}

if (import.meta.main) console.log(formatResult(await collectCodex()))
