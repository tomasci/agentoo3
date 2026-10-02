// Independent verification of the "What's new" backend, against a real
// Postgres — the cases whats-new-db.test.ts leaves out: an entirely empty
// table, a dismissal with no install, the real mark-install script driving
// the pending flag across a dismissal and a re-install, a dismissal that
// names a different install, extra body keys, the same instant spelled
// differently, transport-level bad requests (malformed JSON, wrong
// content-type, no body) with their envelope and no write, more malformed
// stored rows, /api/health's VERSION, and the OpenAPI document.
//
// whats-new-verify-db-child.ts runs every scenario once and reports facts;
// all assertions live here.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const PKG_VERSION = (JSON.parse(await Bun.file(join(BACKEND, 'package.json')).text()) as {
  version: string
}).version

type Facts = Record<string, unknown>
type Res = { status: number; body: unknown }

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''
const hasPostgres = Boolean(postgresBinDir())

async function runChild(): Promise<Facts> {
  if (!cluster) throw new Error('no cluster')
  const child = Bun.spawn(['bun', join(BACKEND, 'tests/whats-new-verify-db-child.ts')], {
    cwd: BACKEND,
    env: {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: `/tmp/agentoo-whats-new-verify-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-whats-new-verify-attachments-${process.pid}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
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
    const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
    throw new Error(`child exited ${code}: ${failure}`)
  }
  return JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
}

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    facts = await runChild()
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
})

const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (value === undefined) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

const NONE = { installedVersion: null, installedAt: null, pending: false }
const A = '2026-01-01T00:00:00.000Z'
const pendingA = { installedVersion: '1.9.0', installedAt: A, pending: true }
const dismissedA = { installedVersion: '1.9.0', installedAt: A, pending: false }

test('the verify scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the whats-new verify scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
})

// --- GET with nothing / only a dismissal -----------------------------------

dbTest('GET on a completely empty system_settings table is {null,null,false} and writes nothing', () => {
  const f = fact<{ rowsBefore: number; get: Res; rowsAfter: number }>('freshEmpty')
  expect(f.rowsBefore).toBe(0)
  expect(f.get).toEqual({ status: 200, body: NONE })
  expect(f.rowsAfter).toBe(0)
})

dbTest('a dismissal row with no last_install still reports {null,null,false}', () => {
  expect(fact<Res>('dismissedNoInstall')).toEqual({ status: 200, body: NONE })
})

// --- the real script across dismiss + re-install ---------------------------

type Run = { code: number; stdout: string; stderr: string }
type Flow = {
  first: Run
  afterFirst: Res
  storedFirst: { version: string; installedAt: string }
  dismissRes: Res
  afterDismiss: Res
  second: Run
  afterSecond: Res
  dismissedAfterSecond: unknown
}

dbTest('mark-install makes the current package version pending, exactly as stored', () => {
  const f = fact<Flow>('realScriptFlow')
  expect(f.first.code).toBe(0)
  expect(f.storedFirst.version).toBe(PKG_VERSION)
  expect(new Date(f.storedFirst.installedAt).toISOString()).toBe(f.storedFirst.installedAt)
  expect(f.afterFirst).toEqual({
    status: 200,
    body: { installedVersion: PKG_VERSION, installedAt: f.storedFirst.installedAt, pending: true },
  })
})

dbTest('dismissing what GET reported clears pending, in the POST response and the next GET', () => {
  const f = fact<Flow>('realScriptFlow')
  const expected = { installedVersion: PKG_VERSION, installedAt: f.storedFirst.installedAt, pending: false }
  expect(f.dismissRes).toEqual({ status: 200, body: expected })
  expect(f.afterDismiss).toEqual({ status: 200, body: expected })
})

dbTest('re-running the real mark-install after a dismissal flips pending back to true', () => {
  const f = fact<Flow>('realScriptFlow')
  expect(f.second.code).toBe(0)
  const after = f.afterSecond.body as { installedVersion: string; installedAt: string; pending: boolean }
  expect(f.afterSecond.status).toBe(200)
  expect(after.installedVersion).toBe(PKG_VERSION)
  expect(after.installedAt).not.toBe(f.storedFirst.installedAt)
  expect(new Date(after.installedAt).getTime()).toBeGreaterThan(new Date(f.storedFirst.installedAt).getTime())
  expect(after.pending).toBe(true)
  // mark-install must not touch the dismissal row.
  expect(f.dismissedAfterSecond).toEqual({ installedAt: f.storedFirst.installedAt })
})

// --- dismissals that do not match ------------------------------------------

dbTest('a dismiss naming a different install is stored as-is and leaves the current one pending', () => {
  const f = fact<{ post: Res; stored: unknown; get: Res }>('nonMatchingDismiss')
  expect(f.post).toEqual({ status: 200, body: pendingA })
  expect(f.stored).toEqual({ installedAt: '2025-12-01T00:00:00.000Z' })
  expect(f.get).toEqual({ status: 200, body: pendingA })
})

dbTest('extra body keys are accepted but only installedAt is stored', () => {
  const f = fact<{ post: Res; stored: unknown }>('extraKeys')
  expect(f.post).toEqual({ status: 200, body: dismissedA })
  expect(f.stored).toEqual({ installedAt: A })
})

type Spelled = { post: Res; stored: unknown; get: Res }

dbTest('the same instant without milliseconds is stored as sent and does not count as a match', () => {
  // The spec compares the strings (`!==`), not the instants.
  const f = fact<Record<string, Spelled>>('spellings').noMillis as Spelled
  expect(f.post).toEqual({ status: 200, body: pendingA })
  expect(f.stored).toEqual({ installedAt: '2026-01-01T00:00:00Z' })
  expect(f.get).toEqual({ status: 200, body: pendingA })
})

for (const name of ['plusOffset', 'zeroOffset']) {
  dbTest(`installedAt with a timezone offset (${name}) is never a 500, and a 400 writes nothing`, () => {
    // The spec says "ISO datetime" without saying whether offsets count.
    // Either reading is allowed here; what is not allowed is a 500, a 400 that
    // still wrote something, or a 200 that rewrote what was sent.
    const f = fact<Record<string, Spelled>>('spellings')[name] as Spelled
    expect([200, 400]).toContain(f.post.status)
    if (f.post.status === 400) {
      expect(f.post.body).toEqual({
        error: 'Validation failed',
        issues: [{ path: 'installedAt', message: 'Invalid ISO datetime' }],
      })
      expect(f.stored).toBeNull()
    } else {
      expect(typeof (f.stored as { installedAt: unknown }).installedAt).toBe('string')
      expect(f.get).toEqual({ status: 200, body: pendingA })
    }
  })
}

// --- transport-level bad requests ------------------------------------------

type Bad = { status: number; body: Record<string, unknown>; storedAfter: unknown }

const UNTOUCHED = { installedAt: 'untouched' }

function expectEnvelope400(f: Bad) {
  expect(f.status).toBe(400)
  expect(typeof f.body).toBe('object')
  expect(typeof f.body.error).toBe('string')
  expect((f.body.error as string).length).toBeGreaterThan(0)
  for (const key of Object.keys(f.body)) expect(['error', 'issues', 'recoveryCommands']).toContain(key)
  expect(f.storedAfter).toEqual(UNTOUCHED)
}

for (const name of [
  'malformedJson',
  'emptyStringBody',
  'textPlainValid',
  'noContentTypeValid',
  'formEncoded',
  'noBodyAtAll',
]) {
  dbTest(`POST ${name} is a 400 in the standard envelope and writes nothing`, () => {
    expectEnvelope400(fact<Record<string, Bad>>('transport')[name] as Bad)
  })
}

const fieldCases: [string, string][] = [
  ['emptyString', 'Invalid ISO datetime'],
  ['dateOnly', 'Invalid ISO datetime'],
  ['nullValue', 'Invalid input: expected string, received null'],
]
for (const [name, message] of fieldCases) {
  dbTest(`POST ${name} is a 400 naming installedAt and writes nothing`, () => {
    const f = fact<Record<string, Bad>>('transport')[name] as Bad
    expect(f.status).toBe(400)
    expect(f.body).toEqual({ error: 'Validation failed', issues: [{ path: 'installedAt', message }] })
    expect(f.storedAfter).toEqual(UNTOUCHED)
  })
}

dbTest('POST with a bare JSON string body is a 400 and writes nothing', () => {
  const f = fact<Record<string, Bad>>('transport').bodyIsString as Bad
  expect(f.status).toBe(400)
  expect(f.body.error).toBe('Validation failed')
  expect(f.storedAfter).toEqual(UNTOUCHED)
})

// --- malformed stored rows ---------------------------------------------------

for (const name of ['dateOnly', 'rfc2822', 'epochNumber', 'emptyVersion', 'numericVersion', 'jsonNull', 'array']) {
  dbTest(`last_install stored as ${name} is treated as absent, with a warning`, () => {
    const f = fact<Record<string, { get: Res; warnings: string[] }>>('badInstalls')[name]
    expect(f?.get).toEqual({ status: 200, body: NONE })
    expect(f?.warnings.some((w) => w.includes('last_install'))).toBe(true)
  })
}

for (const name of ['array', 'bareString', 'garbageDate', 'jsonNull']) {
  dbTest(`whats_new_dismissed stored as ${name} is treated as absent (pending), with a warning`, () => {
    const f = fact<Record<string, { get: Res; warnings: string[] }>>('badDismissals')[name]
    expect(f?.get).toEqual({ status: 200, body: pendingA })
    expect(f?.warnings.some((w) => w.includes('whats_new_dismissed'))).toBe(true)
  })
}

dbTest('a valid dismiss over a malformed dismissal row replaces it', () => {
  const f = fact<{ post: Res; stored: unknown }>('dismissOverMalformed')
  expect(f.post).toEqual({ status: 200, body: dismissedA })
  expect(f.stored).toEqual({ installedAt: A })
})

// --- VERSION and the OpenAPI document --------------------------------------

dbTest('VERSION and GET /api/health still report the package.json version', () => {
  expect(fact<string>('version')).toBe(PKG_VERSION)
  const health = fact<Res>('health')
  expect(health.status).toBe(200)
  expect((health.body as { version: string }).version).toBe(PKG_VERSION)
})

type Doc = {
  paths: Record<string, Record<string, { tags: string[]; responses: Record<string, unknown> }>>
  components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> }
}

dbTest('the OpenAPI document lists both routes under whats-new, returning a named WhatsNewState', () => {
  const res = fact<Res>('openapi')
  expect(res.status).toBe(200)
  const doc = res.body as Doc
  const ref = { $ref: '#/components/schemas/WhatsNewState' }
  const getOp = doc.paths['/api/whats-new']?.get
  const postOp = doc.paths['/api/whats-new/dismiss']?.post
  expect(getOp?.tags).toEqual(['whats-new'])
  expect(postOp?.tags).toEqual(['whats-new'])
  expect(getOp?.responses['200']).toMatchObject({ content: { 'application/json': { schema: ref } } })
  expect(postOp?.responses['200']).toMatchObject({ content: { 'application/json': { schema: ref } } })
  expect(postOp?.responses['400']).toBeDefined()
  const schema = doc.components.schemas.WhatsNewState
  expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['installedAt', 'installedVersion', 'pending'])
  expect([...(schema?.required ?? [])].sort()).toEqual(['installedAt', 'installedVersion', 'pending'])
})
