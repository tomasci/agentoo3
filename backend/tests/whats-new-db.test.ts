// The "What's new" screen's state, against a real Postgres: the pending
// rule (an install present and not yet dismissed for its own installedAt),
// the absent-means-default/malformed-means-absent model both system_settings
// rows follow, POST validation, and — separately from the HTTP app —
// src/mark-install.ts itself, run exactly the way the installer runs it:
// its own process, with only DATABASE_URL in the environment.
//
// The child (whats-new-db-child.ts) runs the HTTP-level scenarios once and
// gathers facts; every assertion on those lives here, mirroring
// system-settings-db.test.ts's own split. mark-install.ts is exercised
// directly from this file instead, because it is never reached through
// createApp() at all — proving it works under a minimal environment is the
// whole point, and routing it through the child (which carries bullmq/
// ioredis/`@/env` mocks of its own) would prove nothing about that.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import postgres from 'postgres'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, unknown>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

async function runChild(): Promise<Facts> {
  if (!cluster) throw new Error('no cluster')
  const child = Bun.spawn(['bun', join(BACKEND, 'tests/whats-new-db-child.ts')], {
    cwd: BACKEND,
    env: {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: `/tmp/agentoo-whats-new-test-projects-${process.pid}`,
      ATTACHMENTS_DIR: `/tmp/agentoo-whats-new-test-attachments-${process.pid}`,
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

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

type Res = { status: number; body: unknown }

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the whats-new scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThan(8)
})

// --- pending logic -----------------------------------------------------------

dbTest('no install recorded: GET reports everything null/false', () => {
  const f = fact<Res>('noInstall')
  expect(f.status).toBe(200)
  expect(f.body).toEqual({ installedVersion: null, installedAt: null, pending: false })
})

dbTest('an install that was never dismissed is pending', () => {
  const f = fact<Res>('installNoDismissal')
  expect(f.status).toBe(200)
  expect(f.body).toEqual({
    installedVersion: '1.9.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    pending: true,
  })
})

dbTest('dismissing the current install clears pending, and GET agrees', () => {
  const f = fact<{ post: Res; stored: unknown; get: Res }>('dismissMatching')
  const expected = {
    installedVersion: '1.9.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    pending: false,
  }
  expect(f.post.status).toBe(200)
  expect(f.post.body).toEqual(expected)
  expect(f.stored).toEqual({ installedAt: '2026-01-01T00:00:00.000Z' })
  expect(f.get.status).toBe(200)
  expect(f.get.body).toEqual(expected)
})

dbTest('a newer install after a dismissal is pending again', () => {
  const f = fact<Res>('newInstallAfterDismissal')
  expect(f.status).toBe(200)
  expect(f.body).toEqual({
    installedVersion: '1.9.1',
    installedAt: '2026-02-01T00:00:00.000Z',
    pending: true,
  })
})

// --- malformed rows are treated as absent, not an error ----------------------

for (const name of ['missingVersion', 'notAnObject', 'badDatetime']) {
  dbTest(`a malformed last_install row (${name}) is treated as absent, with a warning`, () => {
    const f = fact<{ get: Res; warnings: string[] }>(`malformedInstall_${name}`)
    expect(f.get.status).toBe(200)
    expect(f.get.body).toEqual({ installedVersion: null, installedAt: null, pending: false })
    expect(f.warnings.some((w) => w.includes('last_install'))).toBe(true)
  })
}

dbTest('a malformed whats_new_dismissed row is treated as absent — still pending', () => {
  const f = fact<{ get: Res; warnings: string[] }>('malformedDismissal')
  expect(f.get.status).toBe(200)
  expect(f.get.body).toEqual({
    installedVersion: '1.9.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    pending: true,
  })
  expect(f.warnings.some((w) => w.includes('whats_new_dismissed'))).toBe(true)
})

// --- POST validation ---------------------------------------------------------

dbTest('a POST with no body at all is a 400 and changes nothing', () => {
  const f = fact<{ status: number; body: unknown; storedAfter: unknown }>('noBody')
  expect(f.status).toBe(400)
  expect(f.storedAfter).toEqual({ installedAt: 'untouched' })
})

dbTest('a POST with a non-ISO-datetime installedAt is a 400 naming the field', () => {
  const f = fact<{ status: number; body: unknown; storedAfter: unknown }>('badDatetime')
  expect(f.status).toBe(400)
  expect(f.body).toEqual({
    error: 'Validation failed',
    issues: [{ path: 'installedAt', message: 'Invalid ISO datetime' }],
  })
  expect(f.storedAfter).toEqual({ installedAt: 'untouched' })
})

const invalidCases: [name: string, message: string][] = [
  ['empty', 'Invalid input: expected string, received undefined'],
  ['wrongType', 'Invalid input: expected string, received number'],
  ['bodyIsArray', 'Invalid input: expected object, received array'],
  ['bodyIsNull', 'Invalid input: expected object, received null'],
]
for (const [name, message] of invalidCases) {
  dbTest(`POST ${name} is a 400 and changes nothing`, () => {
    const f =
      fact<Record<string, { status: number; body: { issues: { path: string }[] }; storedAfter: unknown }>>(
        'invalid',
      )[name]
    expect(f?.status).toBe(400)
    expect(f?.body.issues[0]?.message).toBe(message)
    expect(f?.storedAfter).toEqual({ installedAt: 'untouched' })
  })
}

// --- a dismiss is stored as the caller sent it, even if it races a newer ----
// install (see service.ts's own comment on why).

dbTest('a dismiss is stored as-is even when it no longer matches the current install', () => {
  const f = fact<{ post: Res; stored: unknown; get: Res }>('racingDismiss')
  expect(f.post.status).toBe(200)
  expect(f.stored).toEqual({ installedAt: '2026-02-15T00:00:00.000Z' })
  // Still pending: the stored dismissal names a different installedAt than
  // the install actually in place.
  expect(f.get.body).toMatchObject({ pending: true })
})

dbTest('a second valid dismiss replaces the first rather than adding a row', () => {
  const f = fact<{ stored: unknown; rows: number; get: Res }>('overwrite')
  expect(f.stored).toEqual({ installedAt: '2026-03-01T00:00:00.000Z' })
  expect(f.rows).toBe(1)
  expect(f.get.body).toMatchObject({ pending: false })
})

// --- src/mark-install.ts, run exactly as the installer runs it --------------
//
// Its own process, with ONLY DATABASE_URL set — not REDIS_URL, not any of the
// other vars `@/env` would otherwise require — because that is the hard
// constraint scripts/68-setup-backend.sh's own invocation operates under.

async function runMarkInstall(env: Record<string, string>) {
  const child = Bun.spawn(['bun', 'run', 'mark-install'], {
    cwd: BACKEND,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

const minimalEnv = (databaseUrl?: string): Record<string, string> => {
  // PATH and HOME are what the installer's own `run_as_app` supplies
  // alongside DATABASE_URL (see scripts/68-setup-backend.sh and that
  // function's own definition) — not a real-world "nothing else at all"
  // environment, which bun itself needs PATH to even be found on.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl
  return env
}

dbTest('mark-install, run with only DATABASE_URL set, records the install', async () => {
  if (!cluster) throw new Error('no cluster')
  const sql = postgres(cluster.connectionString, { max: 1 })
  try {
    await sql`delete from system_settings where key = 'last_install'`
    const pkg = JSON.parse(await Bun.file(join(BACKEND, 'package.json')).text()) as {
      version: string
    }

    const before = Date.now()
    const result = await runMarkInstall(minimalEnv(cluster.connectionString))
    const after = Date.now()

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(pkg.version)

    const [row] = await sql<{ value: { version: string; installedAt: string } }[]>`
      select value from system_settings where key = 'last_install'
    `
    expect(row?.value.version).toBe(pkg.version)
    const installedAtMs = new Date(row?.value.installedAt ?? '').getTime()
    expect(installedAtMs).toBeGreaterThanOrEqual(before - 1000)
    expect(installedAtMs).toBeLessThanOrEqual(after + 1000)
  } finally {
    await sql.end({ timeout: 5 })
  }
})

dbTest('mark-install run twice upserts, never duplicates, the row', async () => {
  if (!cluster) throw new Error('no cluster')
  const sql = postgres(cluster.connectionString, { max: 1 })
  try {
    await sql`delete from system_settings where key = 'last_install'`
    const first = await runMarkInstall(minimalEnv(cluster.connectionString))
    expect(first.code).toBe(0)
    await Bun.sleep(20)
    const second = await runMarkInstall(minimalEnv(cluster.connectionString))
    expect(second.code).toBe(0)

    const rows = await sql`select value, updated_at from system_settings where key = 'last_install'`
    expect(rows.length).toBe(1)
  } finally {
    await sql.end({ timeout: 5 })
  }
})

dbTest('mark-install with no DATABASE_URL at all fails loudly, never a silent success', async () => {
  const result = await runMarkInstall(minimalEnv(undefined))
  expect(result.code).not.toBe(0)
  expect(result.stdout + result.stderr).toContain('DATABASE_URL')
})
