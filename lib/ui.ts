// Shared terminal formatting for the collect/build/sync commands.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const RESET = '\x1b[0m'
export const BOLD = '\x1b[1m'
export const DIM = '\x1b[2m'

export const bold = (s: string) => `${BOLD}${s}${RESET}`
export const dim = (s: string) => `${DIM}${s}${RESET}`

const repoRoot = join(import.meta.dir, '..')

// Long absolute paths dominate the output and hide the numbers, so collapse the
// two prefixes that show up in every line: the repo itself and $HOME.
export function shortPath(p: string): string {
  const clean = p.replace(/\/+$/, '')
  if (clean === repoRoot) return '.'
  if (clean.startsWith(repoRoot + '/')) return clean.slice(repoRoot.length + 1)
  const home = homedir()
  if (clean === home) return '~'
  if (clean.startsWith(home + '/')) return '~' + clean.slice(home.length)
  return clean
}

// `+12 -3`, and an explicit `0 new` when nothing moved — a dash or a blank
// reads as "the command did nothing" rather than "nothing was left to do".
export function formatDelta(added: number, removed: number): string {
  if (!added && !removed) return '0 new'
  const parts: string[] = []
  if (added) parts.push(`+${added}`)
  if (removed) parts.push(`-${removed}`)
  return parts.join(' ')
}

// One row of the collect/sync tables: what moved, how much is there now, and
// where it came from. Every row states a count, so a no-op run still reports.
export type TableRow = { label: string; delta: string; total: number; detail: string }

export function renderRows(rows: TableRow[]): string[] {
  const labelW = Math.max(...rows.map((r) => r.label.length))
  const deltaW = Math.max(...rows.map((r) => r.delta.length))
  const totalW = Math.max(...rows.map((r) => String(r.total).length))
  return rows.map((r) => {
    const delta = r.delta.padStart(deltaW)
    const total = dim(`${String(r.total).padStart(totalW)} files`)
    return `  ${r.label.padEnd(labelW)}  ${r.delta === '0 new' ? dim(delta) : delta}  ${total}  ${dim(r.detail)}`
  })
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
