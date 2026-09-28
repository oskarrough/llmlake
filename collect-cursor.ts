#!/usr/bin/env bun
// Cursor stores chats in one SQLite db (no JSONL on disk), so this collector reads it and emits one slim JSONL per chat into data/sessions/cursor/ for parse-session.ts. Db: <config dir>/Cursor/User/globalStorage/state.vscdb (see ideDbPath) — composerData:<id> = a chat (order inline in conversation[] older, fullConversationHeadersOnly[] newer); bubbleId:<composerId>:<id> = one message (type 1=user/2=assistant, text, modelInfo, tokenCount, toolFormerData, isThought). Older agentKv: blobs are skipped.
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
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

// Cursor IDE's global state db, per platform; CURSOR_DB overrides.
function ideDbPath(): string {
  const env = process.env.CURSOR_DB?.trim()
  if (env) return env
  const rel = 'Cursor/User/globalStorage/state.vscdb'
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support', rel)
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), rel)
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), rel)
}

export async function collectCursor(): Promise<CollectResult> {
  const dbPath = ideDbPath()
  const cliRoot = join(homedir(), '.cursor')
  const dst = sessionsDir('cursor')
  const before = listSessions(dst)
  const hasIde = existsSync(dbPath)
  const hasCli = existsSync(join(cliRoot, 'projects'))
  if (!hasIde && !hasCli) {
    return {
      agent: 'cursor',
      added: 0,
      removed: 0,
      total: before.size,
      source: `${shortPath(dbPath)}, ${shortPath(cliRoot)}`,
      skipped: 'not found',
    }
  }
  const ide = hasIde ? await collectIde(dbPath, dst) : 0
  const cli = hasCli ? await collectCli(cliRoot, join(dst, '_cli')) : 0
  return {
    agent: 'cursor',
    source: [hasIde && shortPath(dbPath), hasCli && shortPath(cliRoot)].filter(Boolean).join(', '),
    note: `${ide + cli} chats read`,
    ...diffCounts(before, listSessions(dst)),
  }
}

// cursor-agent (CLI) writes <root>/projects/<dir>/agent-transcripts/<id>/<id>.jsonl (role + content blocks, no ids, timestamps, tokens or tool results); <root>/chats/<hash>/<id>/meta.json holds cwd, title and created/updated ms. Emits the same slim JSONL as collectIde.
async function collectCli(root: string, dst: string): Promise<number> {
  type Meta = { title?: string; cwd?: string; createdAtMs?: number; updatedAtMs?: number }
  const metas = new Map<string, Meta>()
  for await (const rel of new Bun.Glob('chats/*/*/meta.json').scan({ cwd: root })) {
    try {
      metas.set(rel.split('/')[2]!, JSON.parse(readFileSync(join(root, rel), 'utf8')))
    } catch {}
  }
  mkdirSync(dst, { recursive: true })
  let written = 0
  for await (const rel of new Bun.Glob('projects/*/agent-transcripts/*/*.jsonl').scan({
    cwd: root,
  })) {
    const id = rel.split('/')[3]!
    const src = join(root, rel)
    const meta = metas.get(id) ?? {}
    type Block = { type?: string; text?: string; name?: string; input?: unknown }
    const turns: { role: string; blocks: Block[] }[] = []
    for (const line of readFileSync(src, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (ev.role === 'user' || ev.role === 'assistant')
          turns.push({ role: ev.role, blocks: ev.message?.content ?? [] })
      } catch {}
    }
    if (turns.length === 0) continue
    const created = meta.createdAtMs ?? statSync(src).mtimeMs
    const updated = meta.updatedAtMs ?? created
    const lines: string[] = [
      JSON.stringify({
        role: 'session_meta',
        composerId: id,
        name: meta.title ?? null,
        ts: new Date(created).toISOString(),
        cwd: meta.cwd ?? null,
        model: null,
      }),
    ]
    // Same synthetic timestamp spread as the IDE path.
    const blocks = turns.flatMap((t) => t.blocks.map((b) => ({ role: t.role, b })))
    blocks.forEach(({ role, b }, i) => {
      const ts = new Date(
        created + ((updated - created) * i) / Math.max(1, blocks.length - 1),
      ).toISOString()
      const bubbleId = `${id}:${i}`
      if (b.type === 'tool_use') {
        lines.push(
          JSON.stringify({
            role: 'assistant',
            bubbleId,
            ts,
            tool: { name: b.name ?? null, callId: null, args: b.input ?? null, result: null },
          }),
        )
      } else if (b.type === 'text' && b.text) {
        // User turns wrap the prompt in <timestamp>…<user_query>…</user_query>.
        const text =
          role === 'user'
            ? (b.text.match(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/)?.[1] ?? b.text)
            : b.text
        lines.push(JSON.stringify({ role, bubbleId, ts, text }))
      }
    })
    await Bun.write(join(dst, `${id}.jsonl`), lines.join('\n') + '\n')
    written++
  }
  return written
}

// Cursor IDE: read the global state db and emit one slim JSONL per chat.
async function collectIde(dbPath: string, dst: string): Promise<number> {
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
  return written
}

if (import.meta.main) console.log(formatResult(await collectCursor()))
