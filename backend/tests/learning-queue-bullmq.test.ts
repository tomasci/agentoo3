// The hard queue requirement, against real BullMQ on a real redis-server:
// with the session-run queue's global concurrency at 1 and a `'turn'` job
// already occupying that slot, a `'learning'` job added afterwards does not
// start until the turn job finishes — proving a learning run rides the exact
// same queue-wide cap a session turn does, per this round's own brief ("no
// separate queue or worker may execute the analysis"). See
// learning-queue-bullmq-child.ts for the scenario itself.
//
// Mirrors tests/session-concurrency-bullmq.test.ts's own parent/child split
// and its reasoning for why a real server is non-negotiable here: the cap is
// enforced in Lua inside Redis.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { join } from 'node:path'
import { type RedisServer, redisServerBin, startTempRedis } from './redis-server'

const BACKEND = new URL('..', import.meta.url).pathname

type Facts = Record<string, Record<string, unknown>>

let redis: RedisServer | undefined
let facts: Facts = {}
let setupError = ''

const hasRedis = Boolean(redisServerBin())

if (hasRedis) {
  try {
    redis = await startTempRedis()
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      REDIS_URL: redis.url,
      // Unused by this scenario (no Postgres, no Claude call) but required
      // for @/env to parse at all.
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/learning-queue-bullmq-child.ts')], {
      cwd: BACKEND,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(killer)
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await redis?.stop()
})

const realTest = hasRedis ? test : test.skip

test('the scenario ran at all', () => {
  if (!hasRedis) {
    console.warn('No redis-server on PATH; the real-queue proof did not run.')
    return
  }
  expect(setupError).toBe('')
})

realTest('a learning job does not start until the turn job ahead of it in the same queue finishes', () => {
  const f = facts.proof
  if (!f) throw new Error(`no facts produced (setupError: ${setupError})`)
  expect(f.turnIn).toBe(true)
  expect(f.learningEnteredWhileTurnRunning).toBe(false)
  expect(f.learningInAfterRelease).toBe(true)
  // Never more than one in flight at once — the global cap really is 1.
  expect(f.peak).toBe(1)
  expect(f.enteredOrder).toEqual(['turn', 'learning'])
  expect(f.exitedOrder).toEqual(['turn', 'learning'])
  expect(f.failed).toEqual([])
})
