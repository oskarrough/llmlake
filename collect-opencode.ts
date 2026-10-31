#!/usr/bin/env bun
// opencode stores sessions in one SQLite db (no JSONL on disk), so this collector exports each session's rows verbatim, one JSON line per row, into data/sessions/opencode/<session id>.jsonl for parse-session.ts. Db: <data dir>/opencode/opencode.db (see dbPath). Two layouts live side by side: v1 `session` + `message` + `part` (one row per message, content split into parts) and v2 `session_v2` + `session_message` (content inline). Newer opencode writes v2 and migrated most v1 sessions into it, but some migrated without their messages, so each session exports from v2 unless v1 holds more user/assistant messages.
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionsDir, type CollectResult, formatResult } from './lib/collect.ts'
import { diffCounts, listSessions } from './lib/diff.ts'
import { plural, shortPath } from './lib/ui.ts'

// opencode follows XDG on every platform (~/.local/share unless XDG_DATA_HOME is set); OPENCODE_DB overrides.
function dbPath(): string {
  const env = process.env.OPENCODE_DB?.trim()
  if (env) return env
  const data = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local/share')
  return join(data, 'opencode/opencode.db')
}

type Row = Record<string, unknown>

// Columns holding JSON text become real JSON so the export reads naturally; everything else is copied as-is.
function withJson(row: Row): Row {
  const out: Row = { ...row }
  for (const k of ['data', 'summary_diffs', 'revert', 'permission', 'metadata']) {
    if (typeof out[k] !== 'string') continue
    try {
      out[k] = JSON.parse(out[k] as string)
    } catch {}
  }
  return out
}

export async function collectOpencode(): Promise<CollectResult> {
  const path = dbPath()
  const dst = sessionsDir('opencode')
  const before = listSessions(dst)
  if (!existsSync(path)) {
    return {
      agent: 'opencode',
      added: 0,
      removed: 0,
      total: before.size,
      source: shortPath(path),
      skipped: 'not found',
    }
  }

  // opencode keeps the db open (WAL); snapshot db + -wal to temp and read that so a running opencode never blocks us or hides writes.
  const tmp = mkdtempSync(join(tmpdir(), 'llmlake-opencode-'))
  const snap = join(tmp, 'opencode.db')
  copyFileSync(path, snap)
  if (existsSync(path + '-wal')) copyFileSync(path + '-wal', snap + '-wal')
  // Open read-write on the throwaway copy so SQLite can replay the WAL.
  const db = new Database(snap)

  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name),
  )
  const hasV1 = tables.has('session') && tables.has('message') && tables.has('part')
  const hasV2 = tables.has('session_v2') && tables.has('session_message')

  // user + assistant messages per session in each layout; the export picks the fuller one.
  const count = (sql: string) =>
    new Map(
      db
        .query<{ id: string; n: number }, []>(sql)
        .all()
        .map((r) => [r.id, r.n]),
    )
  const v1Counts = hasV1
    ? count(
        "SELECT session_id AS id, count(*) AS n FROM message WHERE json_extract(data, '$.role') IN ('user', 'assistant') GROUP BY 1",
      )
    : new Map<string, number>()
  const v2Counts = hasV2
    ? count(
        "SELECT session_id AS id, count(*) AS n FROM session_message WHERE type IN ('user', 'assistant') GROUP BY 1",
      )
    : new Map<string, number>()

  const v1Session = hasV1 ? db.query<Row, [string]>('SELECT * FROM session WHERE id = ?') : null
  const v2Session = hasV2 ? db.query<Row, [string]>('SELECT * FROM session_v2 WHERE id = ?') : null
  const v1Messages = hasV1
    ? db.query<Row, [string]>(
        'SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id',
      )
    : null
  const v1Parts = hasV1
    ? db.query<Row, [string]>('SELECT * FROM part WHERE session_id = ? ORDER BY message_id, id')
    : null
  const v2Messages = hasV2
    ? db.query<Row, [string]>(
        'SELECT * FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id',
      )
    : null

  mkdirSync(dst, { recursive: true })
  let read = 0
  let updated = 0
  for (const id of new Set([...v1Counts.keys(), ...v2Counts.keys()])) {
    const useV1 = (v1Counts.get(id) ?? 0) > (v2Counts.get(id) ?? 0)
    const session = useV1 ? v1Session?.get(id) : v2Session?.get(id)
    if (!session) continue
    const lines = [
      JSON.stringify({
        row: 'session',
        table: useV1 ? 'session' : 'session_v2',
        ...withJson(session),
      }),
    ]
    if (useV1) {
      // Each message line is followed by its parts, in id order (opencode ids sort by creation).
      const parts = new Map<string, Row[]>()
      for (const p of v1Parts!.all(id)) {
        const list = parts.get(p.message_id as string) ?? []
        list.push(p)
        parts.set(p.message_id as string, list)
      }
      for (const m of v1Messages!.all(id)) {
        lines.push(JSON.stringify({ row: 'message', ...withJson(m) }))
        for (const p of parts.get(m.id as string) ?? [])
          lines.push(JSON.stringify({ row: 'part', ...withJson(p) }))
      }
    } else {
      for (const m of v2Messages!.all(id))
        lines.push(JSON.stringify({ row: 'session_message', ...withJson(m) }))
    }
    read++
    // Rewrite only when the session changed, so build and Dropbox leave untouched sessions alone.
    const file = join(dst, `${id}.jsonl`)
    const text = lines.join('\n') + '\n'
    const existing = Bun.file(file)
    if ((await existing.exists()) && (await existing.text()) === text) continue
    await Bun.write(file, text)
    updated++
  }

  db.close()
  rmSync(tmp, { recursive: true, force: true })
  return {
    agent: 'opencode',
    source: shortPath(path),
    note: `${plural(read, 'session')} read, ${updated} updated`,
    ...diffCounts(before, listSessions(dst)),
  }
}

if (import.meta.main) console.log(formatResult(await collectOpencode()))
