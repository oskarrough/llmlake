import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collect } from './collect.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'llmlake-collect-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seed(rel: string, body = 'x') {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

// Regression: a mixed-case source dir used to be copied verbatim, lowercased away by normalize, then re-copied on the next run — every collect reported the same "+N" and "removed N dupes".
test('writes mixed-case source dirs to their canonical name so a repeat run adds nothing', async () => {
  await seed('src/-Users-osk-Dropbox-Notes/a.jsonl')
  await seed('src/-Users-osk-Dropbox-Notes/sub/b.jsonl')
  await seed('src/2026/rollout.jsonl')
  await seed('src/top.jsonl')
  await seed('src/-Users-osk-Dropbox-Notes/ignored.txt')
  const src = join(root, 'src', '/')
  const dst = join(root, 'dst', '/')

  const first = await collect('t', dst, [{ src }])
  expect(first.added).toBe(4)
  expect((await readdir(join(root, 'dst'))).sort()).toEqual([
    '-users-osk-dropbox-notes',
    '2026',
    'top.jsonl',
  ])
  expect((await readdir(join(root, 'dst/-users-osk-dropbox-notes'))).sort()).toEqual([
    'a.jsonl',
    'sub',
  ])

  const second = await collect('t', dst, [{ src }])
  expect(second.added).toBe(0)
  expect(second.removed).toBe(0)
  expect(second.total).toBe(4)
})
