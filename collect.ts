#!/usr/bin/env bun
// Run every collect-*.ts in parallel.
import { $ } from 'bun'
import { join } from 'node:path'

const scripts = ['collect-claude.ts', 'collect-pi.ts', 'collect-codex.ts']
await Promise.all(scripts.map((s) => $`bun run ${join(import.meta.dir, s)}`))
