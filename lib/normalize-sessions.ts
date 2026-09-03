// Agents name session dirs after their cwd (`/` → `-`) so filesystem casing leaks in; sync tools then fork "(case conflict)" / "(…'s conflicted copy…)" duplicates that parse as extra sessions (double-counted tokens) and whose apostrophes can wedge the parquet build. This canonicalizes a tree to lowercase, conflict-free names.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Parentheticals mentioning a conflict; agent session names are UUIDs, so "conflict" in parens can't be a legitimate name.
const SYNC_CONFLICT = /\s*\([^)]*conflict[^)]*\)/gi

// Exported so collect can write source dirs straight to their canonical names; otherwise rsync re-copies a mixed-case dir every run after this module lowercases it away.
export function canonicalDir(name: string): string {
  const c = name.replace(SYNC_CONFLICT, '')
  return c.startsWith('-') ? c.toLowerCase() : c
}

function canonicalFile(name: string): string {
  return name.replace(SYNC_CONFLICT, '')
}

export interface NormalizeStats {
  renamed: number
  merged: number
  removed: number
}

// True when two paths resolve to the same inode; on case-insensitive filesystems existsSync(canonical) alone is a false positive and merging would delete the dir's own contents.
async function sameEntry(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

// Case-only rename via a temp dir — a direct rename is a no-op on case-insensitive filesystems.
async function caseRename(from: string, to: string) {
  const tmp = `${to}.normalize-tmp`
  await rm(tmp, { recursive: true, force: true })
  await rename(from, tmp)
  await rename(tmp, to)
}

async function keepLarger(from: string, to: string, stats: NormalizeStats) {
  const [s, d] = await Promise.all([stat(from), stat(to)])
  if (s.size > d.size) await rename(from, to)
  else await rm(from, { force: true })
  stats.removed++
}

// Move every entry of `from` into `to`, normalizing names; `from` is removed.
async function mergeInto(from: string, to: string, stats: NormalizeStats) {
  await mkdir(to, { recursive: true })
  for (const ent of await readdir(from, { withFileTypes: true })) {
    const src = join(from, ent.name)
    if (ent.isDirectory()) {
      const dst = join(to, canonicalDir(ent.name))
      if (existsSync(dst)) await mergeInto(src, dst, stats)
      else await rename(src, dst)
    } else {
      const dst = join(to, canonicalFile(ent.name))
      if (existsSync(dst)) await keepLarger(src, dst, stats)
      else await rename(src, dst)
    }
  }
  await rm(from, { recursive: true, force: true })
  stats.merged++
}

// Canonicalize the direct children of `dir`, recursing into subdirectories.
async function normalizeChildren(dir: string, stats: NormalizeStats) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name)
    if (ent.isDirectory()) {
      const canonical = canonicalDir(ent.name)
      const target = join(dir, canonical)
      if (canonical === ent.name) {
        await normalizeChildren(path, stats)
      } else if (existsSync(target) && !(await sameEntry(path, target))) {
        await mergeInto(path, target, stats)
        await normalizeChildren(target, stats)
      } else {
        await caseRename(path, target)
        stats.renamed++
        await normalizeChildren(target, stats)
      }
    } else {
      const canonical = canonicalFile(ent.name)
      if (canonical === ent.name) continue
      const target = join(dir, canonical)
      if (existsSync(target) && !(await sameEntry(path, target))) {
        await keepLarger(path, target, stats)
      } else {
        await caseRename(path, target)
        stats.renamed++
      }
    }
  }
}

// Canonicalize a session tree in place (idempotent): agent dirs keep their names; encoded-path dirs beneath are lowercased and conflict variants merged into the canonical entry.
export async function normalizeSessionTree(root: string): Promise<NormalizeStats> {
  const stats: NormalizeStats = { renamed: 0, merged: 0, removed: 0 }
  if (existsSync(root)) await normalizeChildren(root, stats)
  return stats
}
