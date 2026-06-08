#!/usr/bin/env bun
// Hermes stores transcripts under ~/.hermes/sessions/YYYYMMDD_HHMMSS_<hash>.jsonl.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collect, sessionsDir } from './lib/collect.ts'

await collect('hermes', sessionsDir('hermes'), [{ src: join(homedir(), '.hermes/sessions/') }])
