// Shared rsync helper for collect-*.ts: copy *.jsonl from source roots into data/sessions/<agent>/ and report what changed. Collectors return results so collect.ts renders one stable-ordered table (parallel collectors printing themselves would interleave).
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { diffCounts, listSessions } from './diff.ts'
import { canonicalDir } from './normalize-sessions.ts'
import { formatDelta, renderRows, type TableRow } from './ui.ts'

export type CollectResult = {
  agent: string
  added: number
  removed: number
  total: number
  /** Where the sessions came from, already shortened for display. */
  source: string
  /** Set when nothing was collected — e.g. the agent isn't installed. */
  skipped?: string
  /** Extra detail for collectors that do more than copy files. */
  note?: string
}

export function resultRow(r: CollectResult): TableRow {
  return {
    label: r.agent,
    delta: r.skipped ? '—' : formatDelta(r.added, r.removed),
    total: r.total,
    detail: r.skipped ? `${r.skipped}: ${r.source}` : (r.note ?? r.source),
  }
}

export function formatResult(r: CollectResult): string {
  return renderRows([resultRow(r)])[0] ?? ''
}

export function sessionsDir(agent: string): string {
  return join(import.meta.dir, '..', 'data/sessions', agent) + '/'
}

// Expand a leading `~/` to the real home directory.
export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

// Copy *.jsonl from src into dst. Top-level dirs land under their canonical (lowercased, conflict-free) name so the tree is already normalized and a repeat run is a no-op; rsync itself can't rename on the way in.
async function syncTree(src: string, dst: string) {
  await $`rsync -a --include='*.jsonl' --exclude='*' ${src} ${dst}`
  for (const ent of await readdir(src, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const to = join(dst, canonicalDir(ent.name), '/')
    await $`mkdir -p ${to}`
    await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${join(src, ent.name, '/')} ${to}`
  }
}

export async function collect(
  agent: string,
  dstRoot: string,
  sources: { src: string; dst?: string; label?: string }[],
): Promise<CollectResult> {
  const before = listSessions(dstRoot)
  const used: string[] = []
  const missing: string[] = []
  for (const { src, dst = dstRoot, label } of sources) {
    if (!existsSync(src)) {
      missing.push(label ?? src)
      continue
    }
    await $`mkdir -p ${dst}`
    await syncTree(src, dst)
    used.push(label ?? src)
  }
  if (used.length === 0) {
    return {
      agent,
      added: 0,
      removed: 0,
      total: before.size,
      source: [...new Set(missing)].join(', '),
      skipped: 'not found',
    }
  }
  return {
    agent,
    source: [...new Set(used)].join(', '),
    ...diffCounts(before, listSessions(dstRoot)),
  }
}
