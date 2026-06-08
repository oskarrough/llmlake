// Agents name session dirs after their cwd (`/` → `-`), so filesystem casing
// leaks in: macOS `-Users-osk-Sites-arbe` vs Linux `-users-osk-sites-arbe`.
// Dropbox is case-insensitive and forks "(case conflict)" copies that never
// converge. This canonicalizes a tree to lowercase, conflict-free names: encoded
// dir names (starting with `-`) are lowercased and any " (case conflict…)" suffix
// stripped; when two entries collapse to one name, dirs merge recursively and
// files keep the LARGER copy (logs are append-only, so larger = more complete).
// Agent dirs (claude/, pi/, …) keep their names; only the path dirs below normalize.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const CASE_CONFLICT = /\s*\(case conflict[^)]*\)/gi

function canonicalDir(name: string): string {
  const c = name.replace(CASE_CONFLICT, '')
  return c.startsWith('-') ? c.toLowerCase() : c
}

function canonicalFile(name: string): string {
  return name.replace(CASE_CONFLICT, '')
}

export interface NormalizeStats {
  renamed: number
  merged: number
  removed: number
}

// True when two paths resolve to the same inode. On case-insensitive filesystems
// `-Users-oskar` and `-users-oskar` are the SAME dir, so existsSync(canonical) is
// a false positive — merging one into the other would delete its own contents.
async function sameEntry(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

// Rename for case only (`-Users-oskar` → `-users-oskar`). A direct rename is a
// no-op on case-insensitive filesystems (POSIX: same file), so go via a temp.
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

// Canonicalize a session tree in place (e.g. data/sessions or a sync dest).
// Idempotent. Agent dirs keep their names; encoded-path dirs beneath them are
// lowercased and "(case conflict)" variants are merged.
export async function normalizeSessionTree(root: string): Promise<NormalizeStats> {
  const stats: NormalizeStats = { renamed: 0, merged: 0, removed: 0 }
  if (existsSync(root)) await normalizeChildren(root, stats)
  return stats
}
