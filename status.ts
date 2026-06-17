#!/usr/bin/env bun
// `./llmlake status` — an instant, zero-AI terminal dashboard over the parquet
// lake. The design has three layers so it stays flexible:
//
//   scoped view  →  questions (SQL)  →  views (compose)  →  renderer (ANSI)
//
//   * scoped     a single view carrying the --period/--agent/--cwd filter, so
//                question SQL never templates a WHERE clause.
//   * questions  self-describing .sql files under queries/ that read FROM
//                scoped and return rows. Adding a question = drop in a .sql.
//   * views      pick question ids + a render hint each (see VIEWS below).
//                Trying a different view costs a few lines, no new SQL.
//
// HTML / interactive renderers can be layered on later: they consume the same
// question rows this file already produces.
import { join } from 'node:path'

// ── args ──────────────────────────────────────────────────────────────────
// ./llmlake status [view] [--period today|7d|30d|month|all] [--days N]
//                         [--agent claude] [--cwd <substring>]
const argv = process.argv.slice(2)
const flags: Record<string, string> = {}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = 'true'
    }
  } else {
    positional.push(a)
  }
}

const viewName = positional[0] ?? 'dashboard'
const period = flags.period ?? (flags.days ? `${flags.days}d` : '7d')

// Translate the period into a SQL predicate over `ts`. Day-based windows are
// calendar days ending today so the daily panel shows N dated rows.
function periodPredicate(p: string): { sql: string; label: string } {
  if (p === 'all') return { sql: 'TRUE', label: 'all time' }
  if (p === 'today') return { sql: 'ts >= current_date', label: 'today' }
  if (p === 'month') {
    return { sql: "ts >= date_trunc('month', current_date)", label: 'this month' }
  }
  const m = p.match(/^(\d+)d?$/)
  const n = m ? Number(m[1]) : 7
  return {
    sql: `ts >= current_date - INTERVAL ${n - 1} DAY`,
    label: n === 1 ? 'today' : `last ${n} days`,
  }
}

const { sql: periodSql, label: periodLabel } = periodPredicate(period)

const scopeClauses = [periodSql]
const scopeLabels: string[] = [periodLabel]
if (flags.agent) {
  scopeClauses.push(`agent = '${flags.agent.replace(/'/g, "''")}'`)
  scopeLabels.push(flags.agent)
}
if (flags.cwd) {
  scopeClauses.push(`cwd ILIKE '%${flags.cwd.replace(/'/g, "''")}%'`)
  scopeLabels.push(`cwd~${flags.cwd}`)
}
const scopeWhere = scopeClauses.join('\n    AND ')

// ── views: question id + how to render it ───────────────────────────────────
type Panel =
  | { q: string; title: string; render: 'header' }
  | { q: string; title: string; render: 'bars'; label: string; value: string; extra?: string[] }
  | { q: string; title: string; render: 'table' }
  | { q: string; title: string; render: 'findings' }

const overview: Panel = { q: 'overview', title: 'Overview', render: 'header' }
const insights: Panel = { q: 'insights', title: 'What to improve', render: 'findings' }
const crossAgent: Panel = { q: 'cross-agent', title: 'By Agent', render: 'table' }

const VIEWS: Record<string, Panel[]> = {
  // Default: lead with what to improve, then the usual cost/activity breakdown.
  dashboard: [
    overview,
    insights,
    {
      q: 'daily-activity',
      title: 'Daily Activity',
      render: 'bars',
      label: 'day',
      value: 'cost_usd',
      extra: ['calls'],
    },
    {
      q: 'by-project',
      title: 'By Project',
      render: 'bars',
      label: 'project',
      value: 'cost_usd',
      extra: ['sessions'],
    },
    {
      q: 'by-model',
      title: 'By Model',
      render: 'bars',
      label: 'model',
      value: 'cost_usd',
      extra: ['events'],
    },
    {
      q: 'tasks',
      title: 'By Activity',
      render: 'bars',
      label: 'family',
      value: 'calls',
      extra: ['pct'],
    },
    { q: 'tool-reliability', title: 'Tools (calls & errors)', render: 'table' },
    crossAgent,
  ],
  // Just the actionable findings — `./llmlake status insights`.
  insights: [overview, insights],
  // Cross-agent comparison — `./llmlake status compare`.
  compare: [crossAgent],
}

const panels = VIEWS[viewName]
if (!panels) {
  console.error(`unknown view '${viewName}'. available: ${Object.keys(VIEWS).join(', ')}`)
  process.exit(1)
}

// ── duckdb session ──────────────────────────────────────────────────────────
// One long-lived duckdb process in `.mode json`. Each question runs between
// sentinel markers (`.print` echoes literal text regardless of mode) so we can
// slice the JSON array for each panel out of the stream.
const root = import.meta.dir
const parquetGlob = join(root, 'data/parquet/**/*.parquet')
const queriesDir = join(root, 'queries')

const initSql = [
  `CREATE OR REPLACE VIEW events AS SELECT * FROM read_parquet('${parquetGlob}', hive_partitioning=true, union_by_name=true);`,
  `CREATE OR REPLACE VIEW scoped AS SELECT * FROM events WHERE\n    ${scopeWhere};`,
].join('\n')

try {
  Bun.spawnSync(['duckdb', '--version'])
} catch {
  console.error('duckdb not found. Install it from https://duckdb.org/docs/installation/')
  process.exit(1)
}

class Duck {
  private proc = Bun.spawn(['duckdb'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  private reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
  private decoder = new TextDecoder()
  private buffer = ''

  async init(sql: string) {
    await this.proc.stdin.write('.mode json\n' + sql + '\n')
    await this.proc.stdin.flush()
  }

  async rows(sql: string): Promise<Record<string, unknown>[]> {
    const begin = `__b_${Math.random().toString(36).slice(2)}__`
    const end = `__e_${Math.random().toString(36).slice(2)}__`
    const clean = sql.trim().replace(/;\s*$/, '')
    await this.proc.stdin.write(`.print ${begin}\n${clean};\n.print ${end}\n`)
    await this.proc.stdin.flush()
    while (!this.buffer.includes(end)) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('duckdb exited before result')
      this.buffer += this.decoder.decode(value, { stream: true })
    }
    const b = this.buffer.indexOf(begin) + begin.length
    const e = this.buffer.indexOf(end)
    const chunk = this.buffer.slice(b, e).trim()
    this.buffer = this.buffer.slice(e + end.length)
    if (!chunk) return []
    try {
      return JSON.parse(chunk) as Record<string, unknown>[]
    } catch {
      return []
    }
  }

  async close() {
    await this.proc.stdin.end()
    await this.proc.exited
  }
}

// ── formatting ──────────────────────────────────────────────────────────────
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const useColor = process.stdout.isTTY || flags.color === 'true'
const c = (code: string, s: string) => (useColor ? code + s + RESET : s)

// Blue → orange → red gradient, used both for bars and panel titles.
function grad(t: number): string {
  t = Math.max(0, Math.min(1, t))
  const stops: [number, number, number][] = [
    [74, 158, 255],
    [255, 170, 68],
    [255, 85, 85],
  ]
  const seg = t < 0.5 ? 0 : 1
  const lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  const a = stops[seg]!
  const bb = stops[seg + 1]!
  const mix = (i: number) => Math.round(a[i]! + (bb[i]! - a[i]!) * lt)
  return fg(mix(0), mix(1), mix(2))
}

const TITLE_COLORS = [
  fg(255, 170, 68), // orange
  fg(74, 158, 255), // blue
  fg(120, 220, 130), // green
  fg(200, 130, 255), // purple
  fg(90, 220, 220), // cyan
]

// duckdb emits some types (HUGEINT from sum(), DECIMAL) as JSON strings, so
// coerce anything number-shaped before formatting.
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}
// Coerce a JSON cell (string | number | boolean | object | null) to a display
// string without tripping the lint against String(unknown).
function str(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v as string | number | boolean | bigint)
}
function humanInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
function humanTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtCost(n: number): string {
  const dp = n >= 1 ? 2 : n >= 0.01 ? 3 : 4
  return '$' + n.toFixed(dp)
}
// Format a numeric cell based on its column name.
function fmtValue(col: string, v: unknown): string {
  if (v == null) return '–'
  const n = toNum(v)
  if (n == null) return str(v)
  const k = col.toLowerCase()
  if (k.includes('cost') || k.includes('usd')) return fmtCost(n)
  if (k.includes('pct')) return n.toFixed(1) + '%'
  if (k.includes('tok')) return humanTok(n)
  return humanInt(n)
}

function bar(frac: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(width * frac)))
  let out = ''
  for (let i = 0; i < filled; i++) out += c(grad((i + 1) / width), '█')
  out += ' '.repeat(width - filled)
  return out
}

// ── renderers ───────────────────────────────────────────────────────────────
const BAR_W = 22
const out: string[] = []

function title(t: string, idx: number) {
  const color = TITLE_COLORS[idx % TITLE_COLORS.length]!
  out.push(c(BOLD + color, t) + '  ' + c(DIM, periodLabel))
}

function renderHeader(rows: Record<string, unknown>[]) {
  const r = rows[0] ?? {}
  const num = (k: string) => toNum(r[k]) ?? 0
  const big = (v: string, label: string) => c(BOLD, v) + ' ' + c(DIM, label)
  out.push(
    [
      big(fmtCost(num('cost_usd')), 'cost'),
      big(humanInt(num('tool_calls')), 'calls'),
      big(humanInt(num('sessions')), 'sessions'),
      big((num('cache_hit_pct') || 0) + '%', 'cache hit'),
    ].join('   '),
  )
  out.push(
    c(
      DIM,
      [
        `${humanTok(num('input_tokens'))} in`,
        `${humanTok(num('output_tokens'))} out`,
        `${humanTok(num('cache_read_tokens'))} cached`,
        `${humanTok(num('cache_write_tokens'))} written`,
      ].join('   '),
    ),
  )
}

function renderBars(rows: Record<string, unknown>[], p: Extract<Panel, { render: 'bars' }>) {
  const vals = rows.map((r) => toNum(r[p.value]) ?? 0)
  const max = Math.max(1, ...vals)
  const labelW = Math.min(24, Math.max(...rows.map((r) => str(r[p.label]).length)))
  const valW = Math.max(...rows.map((_, i) => fmtValue(p.value, vals[i]).length))
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const label = str(r[p.label]).slice(0, labelW).padEnd(labelW)
    const val = fmtValue(p.value, vals[i]).padStart(valW)
    const extras = (p.extra ?? []).map((k) => c(DIM, fmtValue(k, r[k]))).join('  ')
    out.push(
      `${bar(vals[i]! / max, BAR_W)} ${label}  ${c(BOLD, val)}${extras ? '  ' + extras : ''}`,
    )
  }
}

// Wrap prose to `width`, indenting continuation lines by `indent` spaces.
function wrap(text: string, width: number, indent: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line)
      line = ' '.repeat(indent) + w
    } else {
      line = line ? line + ' ' + w : ' '.repeat(indent) + w
    }
  }
  if (line.trim()) lines.push(line)
  return lines
}

const RED = fg(255, 95, 95)
const GREEN = fg(120, 220, 130)

// Findings teach you what to change: a colored headline + a wrapped tip. An
// empty result means nothing crossed a threshold, so we say so explicitly.
function renderFindings(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    out.push(c(GREEN, '✓ Nothing stands out — your sessions look healthy for this period.'))
    return
  }
  for (const r of rows) {
    out.push(c(BOLD + RED, '• ' + str(r.title)))
    for (const line of wrap(str(r.detail), 80, 2)) out.push(c(DIM, line))
  }
}

function renderTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0]!)
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => fmtValue(col, r[col]).length)),
  )
  out.push(c(DIM, cols.map((col, i) => col.padStart(widths[i]!)).join('  ')))
  for (const r of rows) {
    out.push(cols.map((col, i) => fmtValue(col, r[col]).padStart(widths[i]!)).join('  '))
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const duck = new Duck()
await duck.init(initSql)

// Bail early with a friendly message if the lake is empty for this scope.
const [first] = (await duck.rows('SELECT count(*) AS n FROM scoped')) as { n: number }[]
const n = first?.n ?? 0
if (!n) {
  await duck.close()
  console.error(
    `No events in scope (${scopeLabels.join(', ')}).\n` +
      `Run './llmlake collect' and './llmlake build' first, or widen --period.`,
  )
  process.exit(1)
}

out.push('')
out.push(c(BOLD, 'llmlake') + '  ' + c(DIM, scopeLabels.join(' · ')))
out.push('')

let idx = 0
for (const p of panels) {
  const sql = await Bun.file(join(queriesDir, `${p.q}.sql`)).text()
  const rows = await duck.rows(sql)
  // Findings render a healthy message when empty; other panels skip a void.
  if (rows.length === 0 && p.render !== 'findings') continue
  title(p.title, idx++)
  if (p.render === 'header') renderHeader(rows)
  else if (p.render === 'bars') renderBars(rows, p)
  else if (p.render === 'findings') renderFindings(rows)
  else renderTable(rows)
  out.push('')
}

await duck.close()
process.stdout.write(out.join('\n') + '\n')
