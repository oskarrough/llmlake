// Shared terminal formatting for the collect/build/sync/status commands.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const RESET = '\x1b[0m'
export const BOLD = '\x1b[1m'
export const DIM = '\x1b[2m'

// status sets color from TTY/--color true; other commands keep the default (on).
let colorEnabled = true
export function setColorEnabled(v: boolean): void {
  colorEnabled = v
}
export const paint = (code: string, s: string) => (colorEnabled ? code + s + RESET : s)
export const bold = (s: string) => paint(BOLD, s)
export const dim = (s: string) => paint(DIM, s)

const repoRoot = join(import.meta.dir, '..')

// Collapse the two prefixes in every path (repo, $HOME) — long paths hide the numbers.
export function shortPath(p: string): string {
  const clean = p.replace(/\/+$/, '')
  if (clean === repoRoot) return '.'
  if (clean.startsWith(repoRoot + '/')) return clean.slice(repoRoot.length + 1)
  const home = homedir()
  if (clean === home) return '~'
  if (clean.startsWith(home + '/')) return '~' + clean.slice(home.length)
  return clean
}

// `+12 -3`, or an explicit `0 new` — a blank reads as "did nothing" rather than "nothing left to do".
export function formatDelta(added: number, removed: number): string {
  if (!added && !removed) return '0 new'
  const parts: string[] = []
  if (added) parts.push(`+${added}`)
  if (removed) parts.push(`-${removed}`)
  return parts.join(' ')
}

// One collect/sync table row: what moved, how much exists now, where from.
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
