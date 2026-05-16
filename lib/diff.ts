// Helpers for reporting how many session files (.jsonl) a collect-*.ts run
// added or removed from a destination directory.
import { existsSync, readdirSync } from 'node:fs'

export function listSessions(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set()
  return new Set(
    (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')),
  )
}

export function formatDiff(before: Set<string>, after: Set<string>): string {
  let added = 0
  let removed = 0
  for (const f of after) if (!before.has(f)) added++
  for (const f of before) if (!after.has(f)) removed++
  return `+${added} -${removed}`
}
