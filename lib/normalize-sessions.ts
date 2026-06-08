// Most agents name session dirs after their working directory (`/` → `-`), so
// the filesystem's casing leaks into the lake: macOS `~/Sites/arbe` becomes
// `-home-osk-Sites-arbe` while Linux `~/sites/arbe` becomes `-home-osk-sites-arbe`.
// Dropbox is case-insensitive and can't hold both, so it forks "(case conflict)"
// copies that never converge. This canonicalizes a session tree to lowercase,
// conflict-free names by merging case/conflict variants together. Run it over
// the whole data/sessions tree: agent dirs (claude/, pi/, …) keep their names
// while the encoded-path dirs beneath them are normalized.
//
// Merge rule: encoded-cwd dir names (those starting with `-`) are lowercased;
// any name's " (case conflict…)" suffix is stripped. When two entries collapse
// to the same canonical name, dirs are merged recursively and files keep the
// LARGER copy (session logs are append-only, so larger = more complete).
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
      } else if (existsSync(target)) {
        await mergeInto(path, target, stats)
        await normalizeChildren(target, stats)
      } else {
        await rename(path, target)
        stats.renamed++
        await normalizeChildren(target, stats)
      }
    } else {
      const canonical = canonicalFile(ent.name)
      if (canonical === ent.name) continue
      const target = join(dir, canonical)
      if (existsSync(target)) await keepLarger(path, target, stats)
      else {
        await rename(path, target)
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
