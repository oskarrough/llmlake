#!/usr/bin/env bun
// Codex CLI stores transcripts under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
// and $CODEX_HOME/archived_sessions/*.jsonl. CODEX_HOME defaults to ~/.codex.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, sessionsDir } from './lib/collect.ts'
import { expandHome } from './lib/expand-home.ts'

const home = expandHome(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
const dst = sessionsDir('codex')

await collect(`codex (${home})`, dst, [
  { src: join(home, 'sessions/') },
  { src: join(home, 'archived_sessions/'), dst: join(dst, 'archived_sessions/') },
])
