#!/usr/bin/env bun
// Hermes stores transcripts under ~/.hermes/sessions/YYYYMMDD_HHMMSS_<hash>.jsonl.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'

export function collectHermes(): Promise<CollectResult> {
  return collect('hermes', sessionsDir('hermes'), [
    { src: join(homedir(), '.hermes/sessions/'), label: '~/.hermes' },
  ])
}

if (import.meta.main) console.log(formatResult(await collectHermes()))
