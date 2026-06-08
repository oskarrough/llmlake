// Shared rsync helper for the collect-*.ts scripts: copy *.jsonl (recursively)
// from one or more source roots into data/sessions/<agent>/, then report the net
// file-count change. Missing sources are skipped with a warning; if every source
// is missing the process exits 0 without logging.
import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { formatDiff, listSessions } from './diff.ts'

export function sessionsDir(agent: string): string {
  return join(import.meta.dir, '..', 'data/sessions', agent) + '/'
}

export async function collect(
  label: string,
  dstRoot: string,
  sources: { src: string; dst?: string }[],
): Promise<void> {
  const before = listSessions(dstRoot)
  let synced = 0
  for (const { src, dst = dstRoot } of sources) {
    if (!existsSync(src)) {
      console.warn(`skipped ${label}: ${src} does not exist`)
      continue
    }
    await $`mkdir -p ${dst}`
    await $`rsync -a --include='*/' --include='*.jsonl' --exclude='*' ${src} ${dst}`
    synced++
  }
  if (synced === 0) process.exit(0)
  console.log(`synced ${label} -> ${dstRoot}  ${formatDiff(before, listSessions(dstRoot))}`)
}
