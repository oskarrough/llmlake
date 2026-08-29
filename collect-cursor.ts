#!/usr/bin/env bun
// Cursor stores chats in one SQLite db (no JSONL on disk), so this collector reads it and emits one slim JSONL per chat into data/sessions/cursor/ for parse-session.ts. Db: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb — composerData:<id> = a chat (order inline in conversation[] older, fullConversationHeadersOnly[] newer); bubbleId:<composerId>:<id> = one message (type 1=user/2=assistant, text, modelInfo, tokenCount, toolFormerData, isThought). Older agentKv: blobs are skipped.
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatResult, sessionsDir, type CollectResult } from './lib/collect.ts'
import { diffCounts, listSessions } from './lib/diff.ts'
import { shortPath } from './lib/ui.ts'

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

// Deepest shared dir across file paths referenced in the chat (Cursor has no explicit cwd; selections sit under the workspace root).
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

export async function collectCursor(): Promise<CollectResult> {
  const dbPath =
    process.env.CURSOR_DB?.trim() ||
    join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
  const dst = sessionsDir('cursor')
  const before = listSessions(dst)
  if (!existsSync(dbPath)) {
    return {
      agent: 'cursor',
      added: 0,
      removed: 0,
      total: before.size,
      source: shortPath(dbPath),
      skipped: 'not found',
    }
  }

  // Cursor keeps the db open (WAL); snapshot db + -wal to temp and read that so a running Cursor never blocks us or hides writes.
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

  // Newer chats keep an ordered header list with content in bubbleId rows; older chats inline bubbles in conversation[]. Headers first, then inline.
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
    // Bubbles carry no timestamp; spread synthetic ones across the chat's span (approximate but ordered).
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
  return {
    agent: 'cursor',
    source: shortPath(dbPath),
    note: `${written} chats read`,
    ...diffCounts(before, listSessions(dst)),
  }
}

if (import.meta.main) console.log(formatResult(await collectCursor()))
