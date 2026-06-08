#!/usr/bin/env bun
// Pi saves session logs under ~/.pi/agent/sessions/ (organized by cwd).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, sessionsDir } from './lib/collect.ts'

await collect('pi', sessionsDir('pi'), [{ src: join(homedir(), '.pi/agent/sessions/') }])
