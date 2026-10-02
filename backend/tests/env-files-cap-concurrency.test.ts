// The 100-file cap (service.ts's putEnvFile), under real concurrency: 99
// files stored, then 20 concurrent new-path PUTs racing for the one
// remaining slot. Exercises the service function directly rather than
// through the HTTP layer — the race lives entirely in putEnvFile's own
// count-check-then-write, nothing the route layer adds or removes. See
// env-files-cap-concurrency-child.ts for the fixture and why it runs in a
// child process.
//
// Needs a real Postgres (putEnvFile looks up the project row) — see
// pg-cluster.ts for what gets spun up, and env-files-routes.test.ts for the
// identical "skip loudly if this box has none" shape this file copies.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

type RaceFacts = {
  succeeded: number
  rejectedCount: number
  allRejectedAre409: boolean
  totalStored: number
}

let cluster: Cluster | undefined
let facts: { race?: RaceFacts } = {}
let setupError = ''
const projectsDir = await mkdtemp(join(tmpdir(), 'agentoo-env-cap-race-'))

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/env-files-cap-concurrency-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        // Dead on purpose — putEnvFile never dials Redis, but `@/env` still
        // insists on a non-empty value for it.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: projectsDir,
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
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as { race?: RaceFacts }
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(projectsDir, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

const race = (): RaceFacts => {
  if (!facts.race) throw new Error(`child produced no "race" facts (setupError: ${setupError})`)
  return facts.race
}

test('the scenario ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; the cap-concurrency scenario did not run.')
    return
  }
  expect(setupError).toBe('')
})

dbTest('exactly one of 20 concurrent new-path puts fills the last slot to the cap', () => {
  expect(race().succeeded).toBe(1)
  expect(race().rejectedCount).toBe(19)
})

dbTest('every rejected put failed with 409, the cap conflict — never a 500 from the race', () => {
  expect(race().allRejectedAre409).toBe(true)
})

dbTest('the store ends up holding exactly 100 files, not 104 or any other number', () => {
  expect(race().totalStored).toBe(100)
})
