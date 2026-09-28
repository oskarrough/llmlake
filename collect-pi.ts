#!/usr/bin/env bun
// Pi saves session logs under ~/.pi/agent/sessions/ (organized by cwd). bb's Pi bridge writes the same format flat into ~/.bb/pi-bridge-sessions/.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'

export function collectPi(): Promise<CollectResult> {
  const dstRoot = sessionsDir('pi')
  return collect('pi', dstRoot, [
    { src: join(homedir(), '.pi/agent/sessions/'), label: '~/.pi' },
    {
      src: join(homedir(), '.bb/pi-bridge-sessions/'),
      dst: join(dstRoot, '_bb', '/'),
      label: '~/.bb',
    },
  ])
}

if (import.meta.main) console.log(formatResult(await collectPi()))
