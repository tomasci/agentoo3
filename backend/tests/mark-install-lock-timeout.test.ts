// src/mark-install.ts's upsert used to have no bound on how long it would
// wait behind another writer holding the `last_install` row's lock — the
// installer could hang forever on a lock instead of failing the way
// scripts/68-setup-backend.sh already treats any mark-install failure: a
// `log_warn`, never fatal (see that script's own comment on the block).
//
// This holds that row locked from one connection (a transaction that never
// commits for the test's duration) and runs the real `bun run mark-install`,
// exactly as the installer invokes it, against the same database from a
// second, independent connection — proving the configured lock_timeout
// actually bounds the wait rather than merely being present in the source.
//
// Same throwaway-Postgres pattern as system-settings-db.test.ts and
// whats-new-db.test.ts (own process per scenario, one real cluster, thrown
// away afterwards).

import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import postgres from 'postgres'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

// The lock wait this pins is ~15s (mark-install.ts's own lock_timeout) plus
// cluster start/stop overhead.
setDefaultTimeout(45_000)

const BACKEND = new URL('..', import.meta.url).pathname
const hasPostgres = Boolean(postgresBinDir())

let cluster: Cluster | undefined
let setupError = ''

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
})

const dbTest = hasPostgres ? test : test.skip

async function runMarkInstall(databaseUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'run', 'mark-install'], {
    cwd: BACKEND,
    // PATH/HOME/DATABASE_URL only — the same environment
    // scripts/68-setup-backend.sh's `run_as_app` gives it.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code: code ?? -1, stdout, stderr }
}

test('the cluster for the lock-timeout scenario started', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the lock-timeout scenario did not run.')
    return
  }
  expect(setupError).toBe('')
})

dbTest(
  "mark-install gives up — loudly, well short of forever — when another session holds the row's lock",
  async () => {
    if (!cluster) throw new Error('no cluster')
    const lockHolder = postgres(cluster.connectionString, { max: 1 })
    const existing = { version: '1.0.0', installedAt: '2025-01-01T00:00:00.000Z' }
    try {
      // A row for mark-install's own upsert to conflict on: with no existing
      // row at all, INSERT ... ON CONFLICT never needs to lock anything, so
      // a concurrent writer has nothing to block behind.
      await lockHolder`
        insert into system_settings (key, value, updated_at)
        values ('last_install', ${lockHolder.json(existing)}, now())
        on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      `

      let result: { code: number; stdout: string; stderr: string } | undefined
      let elapsedMs = 0
      await lockHolder.begin(async (tx) => {
        // Held open for the rest of this callback: mark-install's own
        // upsert, on its own connection, has to wait on this exact row.
        await tx`select value from system_settings where key = 'last_install' for update`

        const startedAt = Date.now()
        result = await runMarkInstall(cluster.connectionString)
        elapsedMs = Date.now() - startedAt
        // Letting the callback return commits (releasing the lock) — there
        // is nothing left to roll back; the row this held was never written
        // to under the lock.
      })

      if (!result) throw new Error('runMarkInstall did not run')
      // Never zero: a blocked, timed-out upsert is exactly the failure
      // scripts/68-setup-backend.sh's own `log_warn` (not `die`) exists for.
      expect(result.code).not.toBe(0)
      expect(result.stdout + result.stderr).toContain('mark-install failed')
      // The failure is the lock_timeout this file is pinning, not some other
      // cause (a bad DATABASE_URL, a missing table) that would "pass" this
      // assertion for the wrong reason.
      expect((result.stdout + result.stderr).toLowerCase()).toContain('lock timeout')
      // Bounded well short of "forever": comfortably above the ~15s
      // lock_timeout mark-install.ts sets (so this isn't just measuring
      // noise) and comfortably below this test's own 45s budget.
      expect(elapsedMs).toBeGreaterThan(10_000)
      expect(elapsedMs).toBeLessThan(30_000)

      // The blocked attempt never got to write: the row this test seeded is
      // still exactly what it was, not clobbered by a retry this script
      // never made.
      const [row] = await lockHolder<{ value: { version: string } }[]>`
        select value from system_settings where key = 'last_install'
      `
      expect(row?.value.version).toBe(existing.version)
    } finally {
      await lockHolder.end({ timeout: 5 })
    }
  },
)
