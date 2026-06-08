#!/usr/bin/env bun
// Run every collect-*.ts in parallel, then canonicalize the session tree so
// case/conflict variants (e.g. macOS ~/Sites vs Linux ~/sites) don't pile up.
import { $ } from 'bun'
import { join } from 'node:path'
import { normalizeSessionTree } from './lib/normalize-sessions.ts'

const scripts = ['collect-claude.ts', 'collect-pi.ts', 'collect-codex.ts', 'collect-hermes.ts']
await Promise.all(scripts.map((s) => $`bun run ${join(import.meta.dir, s)}`))

const root = join(import.meta.dir, 'data/sessions')
const s = await normalizeSessionTree(root)
if (s.renamed || s.merged || s.removed) {
  console.log(`normalized: renamed ${s.renamed}, merged ${s.merged}, removed ${s.removed} dupes`)
}
