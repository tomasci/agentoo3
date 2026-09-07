// Publishing a project's plugin directory while another turn is reading it.
//
// Two turns in one project can now be in flight at once (WORKER_CONCURRENCY
// defaults to 2 — see env.ts), and every turn starts by rewriting the shared
// plugin directory: `plugin.json` from queue/plugin-manifest.ts, each selected
// agent and skill from features/library/service.ts. Both used to publish in
// place — write over the file, or remove it and copy a new one — which is a
// window where a concurrent reader gets a truncated manifest or no agent file
// at all. These run the real code against a real scratch filesystem, because
// "atomic" is a property of what rename(2) does and nothing faked can show it.
//
// The scenarios run once, in a child process (plugin-atomicity-child.ts) with
// its own PROJECTS_DIR and LIBRARY_DIR: `@/env` parses both at first import and
// setup-env.ts has already fixed them for the shared test process. The child
// gathers facts; every assertion lives here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

const root = await mkdtemp(join(tmpdir(), 'agentoo-plugin-test-'))
let facts: Facts = {}
let setupError = ''

try {
  const child = Bun.spawn(['bun', join(BACKEND, 'tests/plugin-atomicity-child.ts')], {
    cwd: BACKEND,
    env: {
      ...process.env,
      // Neither is dialled: the child fakes the one query these paths make.
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: join(root, 'projects'),
      LIBRARY_DIR: join(root, 'library'),
      ATTACHMENTS_DIR: join(root, 'attachments'),
      LOG_LEVEL: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const marker = stdout.indexOf('__FACTS__')
  if (code !== 0 || marker === -1) {
    const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-2000)
    setupError = `child exited ${code}: ${failure}`
  } else {
    facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
  }
} catch (error) {
  setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all', () => {
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBe(6)
})

// --- the manifest ---------------------------------------------------------------

test('plugin.json is swapped in, not written over the file a reader may hold open', () => {
  // A new inode is what rename() leaves behind. Writing the same file in place
  // keeps it — and with it the window where the plugin silently fails to load
  // because someone read half a JSON document.
  expect(fact('manifest').replacedByRename).toBe(true)
})

test('the manifest that lands is the whole manifest', () => {
  const f = fact('manifest')
  expect(f.parsed).toEqual({
    name: 'agentoo',
    version: '1.0.0',
    description: 'Agents and skills selected for this project.',
  })
  expect(f.endsWithNewline).toBe(true)
})

test('publishing the manifest leaves no temp file behind', () => {
  expect(fact('manifest').leftovers).toEqual([])
})

// --- an agent file --------------------------------------------------------------

test('an agent file is never momentarily absent while it is being republished', () => {
  // 50 republishes with a reader loop running alongside. Any ENOENT at all is
  // a real window: the reader on the other side in production is a Claude Code
  // process loading the plugin at the start of a turn.
  const f = fact('reader')
  expect(f.reads).toBeGreaterThan(100)
  expect(f.missing).toBe(0)
})

test('and it is never read half-copied', () => {
  expect(fact('reader').partial).toBe(0)
})

test('the last version published is the one that is there afterwards', () => {
  const f = fact('reader')
  expect(f.finalContent).toContain('Version 49.')
  expect(f.leftovers).toEqual([])
})

// --- the prune pass -------------------------------------------------------------

test("a sync removes what is no longer selected but not another publish's temp file", () => {
  // Sweeping a `.tmp-` name would delete the source of an in-flight rename and
  // turn the crash-safety above into a spurious ENOENT.
  expect(fact('prune').entries).toEqual(['.tmp-abcdef-tester.md', 'tester.md'])
})

// --- a selection the library no longer has ---------------------------------------

test('an item missing from the library does not fail the sync or strand a temp file', () => {
  const f = fact('missingSource')
  expect(f.threw).toBe('')
  // The failed copy leaves nothing behind — nothing else ever sweeps a
  // `.tmp-` name, so a leak here would be permanent.
  expect(f.agents).toEqual(['tester.md'])
  expect(f.skills).toEqual(['testing'])
  expect(f.skillContents).toEqual(['SKILL.md'])
})

test('a publish that fails after copying cleans up after itself', () => {
  // The copy lands, the rename cannot, and the sync carries on — but the temp
  // file must go, because the prune pass deliberately never touches a `.tmp-`
  // name and nothing else would ever remove it.
  const f = fact('failedPublish')
  expect(f.threw).toBe('')
  expect(f.entries).toEqual(['tester.md'])
})

// --- two syncs of one project ----------------------------------------------------

test('two syncs of the same project run one after the other, not together', () => {
  // A skill is a directory, which rename cannot replace, so the only thing
  // standing between two overlapping rm-then-cp passes over one skill
  // directory is this chain.
  expect(fact('serialization').sameSlug).toBe(1)
})

test('two syncs of different projects still overlap', () => {
  // The chain is per slug. A global lock would serialize every turn on the box
  // behind whichever project synced first — the shape of the original bug.
  expect(fact('serialization').differentSlugs).toBe(2)
})

test('a sync that fails does not swallow its own error, nor block the next one', () => {
  const f = fact('serialization')
  expect(f.outcomes).toEqual(['rejected', 'fulfilled'])
  expect(f.recoveredEntries).toEqual(['tester.md'])
})
