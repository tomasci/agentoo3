// The isolation guarantee the rest of the suite is built on.
//
// `bun test` runs every file in one process and `mock.module` is global to it,
// so a fake that outlives the file that registered it becomes the client every
// later file gets — silently, and only in some file orderings. That is not a
// hypothetical: tests/session-page-scroll.test.tsx's four generated clients and
// tests/storage-page.test.tsx's seven used to escape exactly that way, closure
// state included, because the undo they used (hand `afterAll` the namespace
// object saved before the mock) restores nothing — `mock.module` mutates that
// namespace in place, so the saved "real" module is the fake by the time the
// undo runs.
//
// tests/mock-module.ts is the fix. The first two tests below are its contract:
// live inside the file, gone afterwards. The third is what stops the fix from
// being quietly bypassed by the next file that reaches for `mock.module`
// directly.

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mockModule } from './mock-module'

// An endpoint nothing else in this file touches, so these two tests say
// something about the helper rather than about whoever else mocked what.
const SPEC = '@/shared/api/generated/clients/getApiProjects'
type Namespace = { getApiProjects: unknown }

const fake = async () => 'the fake answered'

test('the fake is live for everything importing the specifier', async () => {
  const before = ((await import(SPEC)) as Namespace).getApiProjects
  const restore = await mockModule(SPEC, () => ({ getApiProjects: fake }))
  try {
    const ns = (await import(SPEC)) as Namespace
    expect(ns.getApiProjects).toBe(fake)
    expect(ns.getApiProjects).not.toBe(before)
  } finally {
    restore()
  }
})

test('restoring puts back the exports that were live before the mock', async () => {
  // Read eagerly into a local: the namespace object itself is not a snapshot,
  // which is the whole reason the naive undo fails.
  const before = ((await import(SPEC)) as Namespace).getApiProjects
  const restore = await mockModule(SPEC, () => ({ getApiProjects: fake }))
  restore()

  const after = ((await import(SPEC)) as Namespace).getApiProjects
  expect(after).toBe(before)
  // Not just "not the fake": the identical function, so a restore that
  // installed some other real-looking implementation would still fail.
  expect(after).not.toBe(fake)
})

test('no test file calls mock.module directly — they go through the helper', () => {
  // A file that registers its own `mock.module` gets no undo, and the leak is
  // back. Prose about `mock.module` is fine; a call is not.
  const dir = new URL('.', import.meta.url).pathname
  const offenders: string[] = []

  for (const name of readdirSync(dir).sort()) {
    if (!/\.test\.tsx?$/.test(name) || name === 'mock-module.test.ts') continue
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      if (/\bmock\.module\s*\(/.test(line)) offenders.push(`${name}:${i + 1}: ${trimmed}`)
    })
  }

  expect(offenders).toEqual([])
})
