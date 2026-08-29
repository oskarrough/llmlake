#!/usr/bin/env bun
// Run every collector (parallel), canonicalize the session tree so case/conflict variants don't pile up, then print one fixed-order table.
import { join } from 'node:path'
import { collectClaude } from './collect-claude.ts'
import { collectCodex } from './collect-codex.ts'
import { collectCursor } from './collect-cursor.ts'
import { collectHermes } from './collect-hermes.ts'
import { collectPi } from './collect-pi.ts'
import { resultRow } from './lib/collect.ts'
import { listSessions } from './lib/diff.ts'
import { normalizeSessionTree } from './lib/normalize-sessions.ts'
import { bold, dim, plural, renderRows, shortPath } from './lib/ui.ts'

const root = join(import.meta.dir, 'data/sessions')

const results = await Promise.all([
  collectClaude(),
  collectCodex(),
  collectCursor(),
  collectHermes(),
  collectPi(),
])

const norm = await normalizeSessionTree(root)

console.log(bold('collect'))
for (const line of renderRows(results.map(resultRow))) console.log(line)

if (norm.renamed || norm.merged || norm.removed) {
  console.log(
    dim(`  cleaned  renamed ${norm.renamed}, merged ${norm.merged}, removed ${norm.removed} dupes`),
  )
}

console.log(`  ${plural(listSessions(root).size, 'session')} in ${shortPath(root)}`)
