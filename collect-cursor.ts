#!/usr/bin/env bun
// Cursor stores chats in a single SQLite db (no JSONL on disk), so unlike the
// rsync-based collectors this one reads the db and *emits* one slim JSONL file
// per chat into data/sessions/cursor/, which parse-session.ts then maps to rows.
//
// Db: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   composerData:<id>           -> a chat. Message order is either inline in
//                                  conversation[] (older) or in
//                                  fullConversationHeadersOnly[] (newer).
//   bubbleId:<composerId>:<id>  -> one message (type 1=user/2=assistant, text,
//                                  modelInfo, tokenCount, toolFormerData, isThought)
// The older `agentKv:` blobs (pre-composer chats, some binary) are skipped.
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions } from './lib/diff.ts'

const dbPath =
  process.env.CURSOR_DB?.trim() ||
  join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')

const dst = join(import.meta.dir, 'data/sessions', 'cursor') + '/'

if (!existsSync(dbPath)) {
  console.warn(`skipped cursor: ${dbPath} does not exist`)
  process.exit(0)
}

type Bubble = {
  type?: number
  text?: string
  isThought?: boolean
  modelInfo?: { modelName?: string }
  tokenCount?: { inputTokens?: number; outputTokens?: number }
  toolFormerData?: {
    name?: string
    toolCallId?: string
    rawArgs?: unknown
    params?: unknown
    result?: unknown
    status?: string
  }
}

// Deepest shared directory across every file path referenced in the chat —
// Cursor has no explicit cwd, but all selections sit under the workspace root.
function deriveCwd(raw: string): string | null {
  const paths = new Set<string>()
  for (const m of raw.matchAll(/"fsPath":\s*"((?:[^"\\]|\\.)+)"/g)) {
    const p = m[1]?.replace(/\\(.)/g, '$1')
    if (p?.startsWith('/')) paths.add(p)
  }
  const split = [...paths].map((p) => p.split('/'))
  const first = split[0]
  if (!first) return null
  const common: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (seg === undefined || !split.every((s) => s[i] === seg)) break
    common.push(seg)
  }
  // A single file collapses to itself; drop a trailing filename segment.
  const last = common[common.length - 1]
  if (last && /\.[^/]+$/.test(last)) common.pop()
  const cwd = common.join('/')
  return cwd && cwd !== '/' ? cwd : null
}

// Cursor keeps the db open (WAL), which can block opening it and also hide
// un-checkpointed writes. Snapshot the db + its -wal to temp and read that, so
// a running Cursor never trips us up.
const tmp = mkdtempSync(join(tmpdir(), 'llmlake-cursor-'))
const snap = join(tmp, 'state.vscdb')
copyFileSync(dbPath, snap)
if (existsSync(dbPath + '-wal')) copyFileSync(dbPath + '-wal', snap + '-wal')
// Open read-write on the throwaway copy so SQLite can replay the WAL.
const db = new Database(snap)

const getBubble = db.query<{ value: string }, [string]>(
  'SELECT value FROM cursorDiskKV WHERE key = ?',
)
const composers = db
  .query<{ key: string; value: string }, []>(
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
  )
  .all()

// Resolve a chat's messages in order. Newer chats keep only an ordered header
// list (fullConversationHeadersOnly) and store content in bubbleId rows; older
// chats inline the whole bubble in conversation[]. Try headers first, fall back
// to inline.
type Composer = {
  conversation?: (Bubble & { bubbleId?: string })[]
  fullConversationHeadersOnly?: { bubbleId?: string }[]
  name?: string
  createdAt?: number
  lastUpdatedAt?: number
  modelConfig?: { modelName?: string }
}
function resolveBubbles(composerId: string, comp: Composer): (Bubble & { bubbleId: string })[] {
  const headers = comp.fullConversationHeadersOnly ?? []
  if (headers.length) {
    const out: (Bubble & { bubbleId: string })[] = []
    for (const h of headers) {
      if (!h.bubbleId) continue
      const row = getBubble.get(`bubbleId:${composerId}:${h.bubbleId}`)
      if (!row) continue
      try {
        out.push({ ...(JSON.parse(row.value) as Bubble), bubbleId: h.bubbleId })
      } catch {}
    }
    return out
  }
  return (comp.conversation ?? []).filter(
    (e): e is Bubble & { bubbleId: string } => typeof e.bubbleId === 'string',
  )
}

const cleanModel = (m?: string): string | null => (m && m !== 'default' ? m : null)

let written = 0
for (const { key, value } of composers) {
  const composerId = key.slice('composerData:'.length)
  let comp: Composer
  try {
    comp = JSON.parse(value)
  } catch {
    continue
  }
  if (!comp || typeof comp !== 'object') continue
  const bubbles = resolveBubbles(composerId, comp)
  if (bubbles.length === 0) continue

  const created = comp.createdAt ?? comp.lastUpdatedAt ?? null
  const updated = comp.lastUpdatedAt ?? created
  const cwd = deriveCwd(value)
  const sessionModel = cleanModel(comp.modelConfig?.modelName)
  // Bubbles carry no timestamp; spread synthetic ones across the chat's span so
  // time-series queries work. Approximate but ordered.
  const span = created != null && updated != null && updated > created ? updated - created : 0
  const tsAt = (i: number): string | null =>
    created == null
      ? null
      : new Date(created + (span * i) / Math.max(1, bubbles.length - 1)).toISOString()

  const lines: string[] = [
    JSON.stringify({
      role: 'session_meta',
      composerId,
      name: comp.name ?? null,
      ts: created == null ? null : new Date(created).toISOString(),
      cwd,
      model: sessionModel,
    }),
  ]

  bubbles.forEach((b, i) => {
    const bubbleId = b.bubbleId
    const ts = tsAt(i)
    const model = cleanModel(b.modelInfo?.modelName) ?? sessionModel

    const tf = b.toolFormerData
    if (tf && tf.name) {
      lines.push(
        JSON.stringify({
          role: 'assistant',
          bubbleId,
          ts,
          model,
          tool: {
            name: tf.name,
            callId: tf.toolCallId ?? null,
            args: tf.rawArgs ?? tf.params ?? null,
            result: tf.result ?? null,
            isError: tf.status === 'error',
          },
        }),
      )
      return
    }
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text) return // empty stub bubble (loading tool, etc.)
    if (b.type === 1) {
      lines.push(JSON.stringify({ role: 'user', bubbleId, ts, text }))
    } else {
      lines.push(
        JSON.stringify({
          role: 'assistant',
          bubbleId,
          ts,
          model,
          isThought: b.isThought === true,
          text,
          inputTokens: b.tokenCount?.inputTokens ?? null,
          outputTokens: b.tokenCount?.outputTokens ?? null,
        }),
      )
    }
  })

  if (lines.length === 1) continue // meta only, no real messages
  await Bun.write(join(dst, `${composerId}.jsonl`), lines.join('\n') + '\n')
  written++
}

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`synced cursor -> ${dst}  ${written} chats (${listSessions(dst).size} files total)`)
