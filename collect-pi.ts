#!/usr/bin/env bun
// Pi and BB write the same JSONL format. Keep both BB paths for older installs and logs.
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
    {
      src: join(homedir(), '.bb/plugins/provider-pi/bridge-data/sessions/'),
      dst: join(dstRoot, '_bb', '/'),
      label: '~/.bb',
    },
  ])
}

if (import.meta.main) console.log(formatResult(await collectPi()))
