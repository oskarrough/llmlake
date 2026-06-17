import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSessionTree } from './normalize-sessions.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'llmlake-normalize-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seed(rel: string, body: string) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

// Regression: on case-insensitive filesystems (macOS, Dropbox) a mixed-case
// encoded dir collides with its own lowercase canonical, so the old code merged
// the dir into itself — deleting every session file and then crashing on the
// recursion. It must instead case-rename and preserve the files.
test('lowercases a mixed-case encoded dir without losing files', async () => {
  await seed('claude/-Users-oskar-Sites-llmlake/a.jsonl', 'hello')
  await seed('claude/-Users-oskar-Sites-llmlake/b.jsonl', 'world')

  const stats = await normalizeSessionTree(root)

  const dirs = await readdir(join(root, 'claude'))
  expect(dirs).toEqual(['-users-oskar-sites-llmlake'])
  const files = (await readdir(join(root, 'claude/-users-oskar-sites-llmlake'))).sort()
  expect(files).toEqual(['a.jsonl', 'b.jsonl'])
  expect(await readFile(join(root, 'claude/-users-oskar-sites-llmlake/a.jsonl'), 'utf8')).toBe(
    'hello',
  )
  expect(stats.renamed).toBeGreaterThan(0)
  expect(stats.removed).toBe(0)
})

// A genuine Dropbox "(case conflict)" fork is a separate physical dir (its name
// differs by more than case), so it must still be merged, keeping the larger
// append-only log.
test('merges a case-conflict fork, keeping the larger file', async () => {
  await seed('claude/-users-oskar-sites-arbe/s.jsonl', 'short')
  await seed('claude/-Users-oskar-Sites-arbe (case conflict 1)/s.jsonl', 'much-longer-content')

  await normalizeSessionTree(root)

  const dirs = await readdir(join(root, 'claude'))
  expect(dirs).toEqual(['-users-oskar-sites-arbe'])
  expect(await readFile(join(root, 'claude/-users-oskar-sites-arbe/s.jsonl'), 'utf8')).toBe(
    'much-longer-content',
  )
})

test('is idempotent on an already-canonical tree', async () => {
  await seed('claude/-Users-oskar-Sites-x/a.jsonl', 'data')
  await normalizeSessionTree(root)
  const second = await normalizeSessionTree(root)
  expect(second).toEqual({ renamed: 0, merged: 0, removed: 0 })
})
