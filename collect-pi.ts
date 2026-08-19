#!/usr/bin/env bun
// Pi saves session logs under ~/.pi/agent/sessions/ (organized by cwd).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'

export function collectPi(): Promise<CollectResult> {
  return collect('pi', sessionsDir('pi'), [
    { src: join(homedir(), '.pi/agent/sessions/'), label: '~/.pi' },
  ])
}

if (import.meta.main) console.log(formatResult(await collectPi()))
