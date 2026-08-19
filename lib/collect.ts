// Shared rsync helper for the collect-*.ts scripts: copy *.jsonl (recursively)
// from one or more source roots into data/sessions/<agent>/, then report what
// changed. Collectors return a result instead of printing it, so collect.ts can
// render every agent in one stable-ordered table (they run in parallel, so
// self-printing collectors interleaved unpredictably).
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { diffCounts, listSessions } from './diff.ts'
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

export function countSessions(dir: string): number {
  return listSessions(dir).size
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
    await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
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
