#!/usr/bin/env bun
// `./llmlake status` — an instant, zero-AI terminal dashboard over the parquet
// lake. Data flows in four stages, top to bottom in this file:
//
//   args/scope  →  views  →  runQuestions (duckdb)  →  renderers  →  main()
//
//   * scope      a `scoped` SQL view carrying --period/--agent/--cwd, so
//                question SQL never has to template a WHERE clause.
//   * questions  self-describing .sql files in queries/ that read FROM scoped
//                and return rows. Adding one = drop in a .sql file.
//   * views      pick question ids + a render hint each (see VIEWS).
//   * renderers  pure: take rows, return lines. ANSI today; an HTML renderer
//                could consume the same rows later.
import { join } from 'node:path'
import { ensureDuckdb, runQuestions, type Row } from './lib/duck.ts'

const queriesDir = join(import.meta.dir, 'queries')
const parquetGlob = join(import.meta.dir, 'data/parquet/**/*.parquet')

// ── args + scope ────────────────────────────────────────────────────────────
type Flags = Record<string, string>

function parseArgs(argv: string[]): { view: string; flags: Flags } {
  const flags: Flags = {}
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
  return { view: positional[0] ?? 'dashboard', flags }
}

const sqlLit = (s: string) => s.replace(/'/g, "''")

// Translate a --period value into a SQL predicate over `ts` and a label. Day
// windows are calendar days ending today, so the daily panel shows N dated rows.
function periodPredicate(p: string): { sql: string; label: string } {
  if (p === 'all') return { sql: 'TRUE', label: 'all time' }
  if (p === 'today') return { sql: 'ts >= current_date', label: 'today' }
  if (p === 'month') return { sql: "ts >= date_trunc('month', current_date)", label: 'this month' }
  const n = Number(p.match(/^(\d+)d?$/)?.[1] ?? 7)
  return {
    sql: `ts >= current_date - INTERVAL ${n - 1} DAY`,
    label: n === 1 ? 'today' : `last ${n} days`,
  }
}

type Scope = { where: string; labels: string[]; periodLabel: string }

function buildScope(flags: Flags): Scope {
  const period = flags.period ?? (flags.days ? `${flags.days}d` : '7d')
  const { sql, label } = periodPredicate(period)
  const clauses = [sql]
  const labels = [label]
  if (flags.agent) {
    clauses.push(`agent = '${sqlLit(flags.agent)}'`)
    labels.push(flags.agent)
  }
  if (flags.cwd) {
    clauses.push(`cwd ILIKE '%${sqlLit(flags.cwd)}%'`)
    labels.push(`cwd~${flags.cwd}`)
  }
  return { where: clauses.join('\n    AND '), labels, periodLabel: label }
}

// ── views: which questions to show, and how to render each ──────────────────
type Panel =
  | { question: string; title: string; render: 'header' }
  | {
      question: string
      title: string
      render: 'bars'
      label: string
      value: string
      extra?: string[]
    }
  | { question: string; title: string; render: 'table' }
  | { question: string; title: string; render: 'findings' }

const overview: Panel = { question: 'overview', title: 'Overview', render: 'header' }
const insights: Panel = { question: 'insights', title: 'What to improve', render: 'findings' }
const byAgent: Panel = { question: 'cross-agent', title: 'By Agent', render: 'table' }

const VIEWS: Record<string, Panel[]> = {
  // Default: lead with what to improve, then the usual cost/activity breakdown.
  dashboard: [
    overview,
    insights,
    {
      question: 'daily-activity',
      title: 'Daily Activity',
      render: 'bars',
      label: 'day',
      value: 'cost_usd',
      extra: ['calls'],
    },
    {
      question: 'by-project',
      title: 'By Project',
      render: 'bars',
      label: 'project',
      value: 'cost_usd',
      extra: ['sessions'],
    },
    {
      question: 'by-model',
      title: 'By Model',
      render: 'bars',
      label: 'model',
      value: 'cost_usd',
      extra: ['events'],
    },
    {
      question: 'tasks',
      title: 'By Activity',
      render: 'bars',
      label: 'family',
      value: 'calls',
      extra: ['pct'],
    },
    { question: 'tool-reliability', title: 'Tools (calls & errors)', render: 'table' },
    byAgent,
  ],
  insights: [overview, insights], // `./llmlake status insights`
  compare: [byAgent], //              `./llmlake status compare`
}

// ── data: the views questions read from ─────────────────────────────────────
// `scoped` carries the scope filter; questions read FROM it. Running the
// queries is delegated to lib/duck.ts.
function initSql(scope: Scope): string {
  return [
    `CREATE OR REPLACE VIEW events AS SELECT * FROM read_parquet('${parquetGlob}', hive_partitioning=true, union_by_name=true);`,
    `CREATE OR REPLACE VIEW scoped AS SELECT * FROM events WHERE\n    ${scope.where};`,
  ].join('\n')
}

// ── formatting helpers ──────────────────────────────────────────────────────
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`

let colorEnabled = true
const paint = (code: string, s: string) => (colorEnabled ? code + s + RESET : s)

// Blue → orange → red gradient, used for bars and panel titles.
function gradient(t: number): string {
  t = Math.max(0, Math.min(1, t))
  const stops: [number, number, number][] = [
    [74, 158, 255],
    [255, 170, 68],
    [255, 85, 85],
  ]
  const seg = t < 0.5 ? 0 : 1
  const lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  const a = stops[seg]!
  const b = stops[seg + 1]!
  const mix = (i: number) => Math.round(a[i]! + (b[i]! - a[i]!) * lt)
  return fg(mix(0), mix(1), mix(2))
}

const TITLE_COLORS = [
  fg(255, 170, 68), // orange
  fg(74, 158, 255), // blue
  fg(120, 220, 130), // green
  fg(200, 130, 255), // purple
  fg(90, 220, 220), // cyan
]
const RED = fg(255, 95, 95)
const GREEN = fg(120, 220, 130)

// duckdb emits some types (HUGEINT from sum(), DECIMAL) as JSON strings, so
// coerce anything number-shaped before formatting.
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}

// Coerce a JSON cell to a display string without tripping String(unknown).
function cell(v: unknown): string {
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

// Format a numeric cell based on its column name; non-numbers pass through.
function fmtValue(col: string, v: unknown): string {
  if (v == null) return '–'
  const n = toNum(v)
  if (n == null) return cell(v)
  const k = col.toLowerCase()
  if (k.includes('cost') || k.includes('usd')) return fmtCost(n)
  if (k.includes('pct')) return n.toFixed(1) + '%'
  if (k.includes('tok')) return humanTok(n)
  return humanInt(n)
}

const BAR_W = 22

function bar(frac: number): string {
  const filled = Math.max(0, Math.min(BAR_W, Math.round(BAR_W * frac)))
  let s = ''
  for (let i = 0; i < filled; i++) s += paint(gradient((i + 1) / BAR_W), '█')
  return s + ' '.repeat(BAR_W - filled)
}

// Wrap prose to `width`, indenting continuation lines by `indent` spaces.
function wrap(text: string, width: number, indent: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const w of text.split(/\s+/)) {
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

// ── renderers: each takes rows, returns lines (no shared state) ─────────────
function renderHeader(rows: Row[]): string[] {
  const r = rows[0] ?? {}
  const num = (k: string) => toNum(r[k]) ?? 0
  const stat = (v: string, label: string) => paint(BOLD, v) + ' ' + paint(DIM, label)
  return [
    [
      stat(fmtCost(num('cost_usd')), 'cost'),
      stat(humanInt(num('tool_calls')), 'calls'),
      stat(humanInt(num('sessions')), 'sessions'),
      stat((num('cache_hit_pct') || 0) + '%', 'cache hit'),
    ].join('   '),
    paint(
      DIM,
      [
        `${humanTok(num('input_tokens'))} in`,
        `${humanTok(num('output_tokens'))} out`,
        `${humanTok(num('cache_read_tokens'))} cached`,
        `${humanTok(num('cache_write_tokens'))} written`,
      ].join('   '),
    ),
  ]
}

function renderBars(rows: Row[], p: Extract<Panel, { render: 'bars' }>): string[] {
  const vals = rows.map((r) => toNum(r[p.value]) ?? 0)
  const max = Math.max(1, ...vals)
  const labelW = Math.min(24, Math.max(...rows.map((r) => cell(r[p.label]).length)))
  const valW = Math.max(...vals.map((v) => fmtValue(p.value, v).length))
  return rows.map((r, i) => {
    const label = cell(r[p.label]).slice(0, labelW).padEnd(labelW)
    const val = fmtValue(p.value, vals[i]).padStart(valW)
    const extras = (p.extra ?? []).map((k) => paint(DIM, fmtValue(k, r[k]))).join('  ')
    return `${bar(vals[i]! / max)} ${label}  ${paint(BOLD, val)}${extras ? '  ' + extras : ''}`
  })
}

// Findings teach you what to change: a colored headline + a wrapped tip. An
// empty result means nothing crossed a threshold, so we say so explicitly.
function renderFindings(rows: Row[]): string[] {
  if (rows.length === 0) {
    return [paint(GREEN, '✓ Nothing stands out — your sessions look healthy for this period.')]
  }
  return rows.flatMap((r) => [
    paint(BOLD + RED, '• ' + cell(r.title)),
    ...wrap(cell(r.detail), 80, 2).map((line) => paint(DIM, line)),
  ])
}

function renderTable(rows: Row[]): string[] {
  if (rows.length === 0) return []
  const cols = Object.keys(rows[0]!)
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => fmtValue(col, r[col]).length)),
  )
  const fmtRow = (vals: string[]) => vals.map((v, i) => v.padStart(widths[i]!)).join('  ')
  return [
    paint(DIM, fmtRow(cols)),
    ...rows.map((r) => fmtRow(cols.map((col) => fmtValue(col, r[col])))),
  ]
}

// Title (colored, with the period) plus the rendered body for one panel.
function renderPanel(p: Panel, rows: Row[], idx: number, periodLabel: string): string[] {
  const head =
    paint(BOLD + TITLE_COLORS[idx % TITLE_COLORS.length]!, p.title) + '  ' + paint(DIM, periodLabel)
  const body =
    p.render === 'header'
      ? renderHeader(rows)
      : p.render === 'bars'
        ? renderBars(rows, p)
        : p.render === 'findings'
          ? renderFindings(rows)
          : renderTable(rows)
  return [head, ...body]
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const { view, flags } = parseArgs(process.argv.slice(2))
  colorEnabled = process.stdout.isTTY || flags.color === 'true'

  const panels = VIEWS[view]
  if (!panels) {
    console.error(`unknown view '${view}'. available: ${Object.keys(VIEWS).join(', ')}`)
    process.exit(1)
  }
  ensureDuckdb()
  const scope = buildScope(flags)

  // Each panel's SQL, plus an inline scope-count used for the empty check.
  const queries: Record<string, string> = { _count: 'SELECT count(*) AS n FROM scoped' }
  for (const p of panels) {
    queries[p.question] ??= await Bun.file(join(queriesDir, `${p.question}.sql`)).text()
  }
  const results = await runQuestions(initSql(scope), queries)

  if ((toNum(results._count?.[0]?.n) ?? 0) === 0) {
    console.error(
      `No events in scope (${scope.labels.join(', ')}).\n` +
        `Run './llmlake collect' and './llmlake build' first, or widen --period.`,
    )
    process.exit(1)
  }

  const lines = ['', paint(BOLD, 'llmlake') + '  ' + paint(DIM, scope.labels.join(' · ')), '']
  let idx = 0
  for (const p of panels) {
    const rows = results[p.question] ?? []
    // Findings render a healthy message when empty; other panels skip a void.
    if (rows.length === 0 && p.render !== 'findings') continue
    lines.push(...renderPanel(p, rows, idx++, scope.periodLabel), '')
  }
  process.stdout.write(lines.join('\n') + '\n')
}

await main()
