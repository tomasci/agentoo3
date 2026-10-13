// SessionDto.lastMessageAt and the project sessions list's activity order,
// against a real Postgres:
//
//   - lastMessageAt is the ISO created_at of the session's newest `messages`
//     row of any type — a still-pending queued prompt included — and null for
//     a session with no messages; the newest by time, not by seq, and never a
//     neighbouring session's;
//   - every endpoint answering with a session DTO carries it: POST create,
//     GET /projects/{id}/sessions, GET /sessions/{id}, PATCH /sessions/{id},
//     and all three GET /sessions/overview lists; and the OpenAPI document
//     declares it, nullable;
//   - GET /projects/{id}/sessions is ordered by `lastMessageAt ?? createdAt`
//     descending, then createdAt descending — not by createdAt alone, and not
//     by updatedAt — and a rename or settings edit bumps updatedAt without
//     moving lastMessageAt or the order, while a newly queued prompt does
//     move the session to the top.
//
// The fixtures live in sessions-last-message-db-child.ts, run as a child
// process for the `@/env` first-import-wins reason pg-cluster.ts explains.
// Skipped, loudly, only on a box with no Postgres server installed.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const MIGRATIONS = join(BACKEND, 'src/db/migrations')
const TEMP_PROJECTS = `/tmp/agentoo-last-message-test-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-last-message-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(MIGRATIONS)
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/sessions-last-message-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        // Never dialled: the child fakes ioredis and bullmq.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: TEMP_PROJECTS,
        ATTACHMENTS_DIR: TEMP_ATTACHMENTS,
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
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
  await rm(TEMP_ATTACHMENTS, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

const fact = <T = Record<string, unknown>>(name: string): T => {
  if (setupError) throw new Error(setupError)
  const f = facts[name]
  if (!f) throw new Error(`no fact ${name}`)
  return f as T
}

dbTest('the fixture child ran to completion', () => {
  expect(setupError).toBe('')
})

// --- the value ---------------------------------------------------------------

type Values = {
  none: { hasKey: boolean; lastMessageAt: unknown; count: number }
  mixed: { lastMessageAt: string; expected: string; count: number }
  outOfSeq: { lastMessageAt: string; expected: string }
  pending: {
    lastMessageAt: string
    pendingRowCreatedAt: string
    newestRowCreatedAt: string
    pendingRowSeq: number
    sentSeq: number
    pendingPrompts: number
    count: number
    isoShape: boolean
  }
}

dbTest('no messages: lastMessageAt is present and null, messageCount 0', () => {
  const { none } = fact<Values>('values')
  expect(none).toEqual({ hasKey: true, lastMessageAt: null, count: 0 })
})

dbTest('messages of every type: lastMessageAt is the newest created_at; count still right', () => {
  const { mixed } = fact<Values>('values')
  expect(mixed.lastMessageAt).toBe(mixed.expected)
  expect(mixed.count).toBe(4)
})

dbTest('the newest by created_at wins even when it has the lower seq', () => {
  const { outOfSeq } = fact<Values>('values')
  expect(outOfSeq.lastMessageAt).toBe(outOfSeq.expected)
})

dbTest('a still-pending queued prompt is the newest message and counts', () => {
  const { pending } = fact<Values>('values')
  // The prompt sendMessage just queued behind the running turn.
  expect(pending.pendingPrompts).toBe(1)
  expect(pending.pendingRowSeq).toBe(pending.sentSeq)
  expect(pending.pendingRowCreatedAt).toBe(pending.newestRowCreatedAt)
  expect(pending.lastMessageAt).toBe(pending.pendingRowCreatedAt)
  expect(pending.count).toBe(3)
  expect(pending.isoShape).toBe(true)
})

// --- every endpoint carries it ----------------------------------------------

dbTest('POST /projects/{id}/sessions answers with lastMessageAt: null', () => {
  const created = fact<{ status: number; hasKey: boolean; lastMessageAt: unknown }>('create')
  expect(created).toEqual({ status: 201, hasKey: true, lastMessageAt: null })
})

type ListFacts = { order: string[]; lastMessageAt: Record<string, string | null>; hasKey: boolean }
type Order = {
  before: ListFacts
  afterRename: ListFacts
  afterSend: ListFacts
  getMatchesList: Record<string, boolean>
  renames: Record<string, Record<string, unknown>>
  expected: { T4: string; a: string; c: string; g: string }
}

const EXPECTED_ORDER = [
  'a-created-10d-spoke-1h',
  'b-created-2h-no-messages',
  'c-created-5d-spoke-3h',
  // Three at T4: by createdAt among equals, newest first.
  'f-no-messages-created-T4',
  'd-T4-created-1d',
  'e-T4-created-2d',
  // Updated a minute ago, but last spoke ten days ago.
  'g-old-activity-recently-updated',
  'h-old-no-messages',
]

dbTest(
  'GET /projects/{id}/sessions carries lastMessageAt on every row, with the right values',
  () => {
    const { before, expected } = fact<Order>('order')
    expect(before.hasKey).toBe(true)
    expect(before.lastMessageAt).toEqual({
      'a-created-10d-spoke-1h': expected.a,
      'b-created-2h-no-messages': null,
      'c-created-5d-spoke-3h': expected.c,
      'f-no-messages-created-T4': null,
      'd-T4-created-1d': expected.T4,
      'e-T4-created-2d': expected.T4,
      'g-old-activity-recently-updated': expected.g,
      'h-old-no-messages': null,
    })
  },
)

dbTest('GET /sessions/{id} answers the same lastMessageAt as the list, for every session', () => {
  const { getMatchesList } = fact<Order>('order')
  expect(Object.keys(getMatchesList).length).toBe(EXPECTED_ORDER.length)
  for (const [title, same] of Object.entries(getMatchesList))
    expect([title, same]).toEqual([title, true])
})

type OverviewFacts = {
  status: number
  running: { hasKey: boolean; lastMessageAt: string | null } | null
  unchecked: { hasKey: boolean; lastMessageAt: string | null } | null
  recent: { hasKey: boolean; lastMessageAt: string | null } | null
  recentEmpty: { hasKey: boolean; lastMessageAt: string | null } | null
  runningInRecent: { hasKey: boolean; lastMessageAt: string | null } | null
  everyRowHasKey: boolean
  expected: { running: string; unchecked: string; recent: string }
}

dbTest(
  'GET /sessions/overview: running, unchecked and recent all carry the right lastMessageAt',
  () => {
    const ov = fact<OverviewFacts>('overview')
    expect(ov.status).toBe(200)
    expect(ov.everyRowHasKey).toBe(true)
    expect(ov.running).toEqual({ hasKey: true, lastMessageAt: ov.expected.running })
    expect(ov.unchecked).toEqual({ hasKey: true, lastMessageAt: ov.expected.unchecked })
    expect(ov.recent).toEqual({ hasKey: true, lastMessageAt: ov.expected.recent })
    expect(ov.recentEmpty).toEqual({ hasKey: true, lastMessageAt: null })
    // The same session in two lists answers the same value in both.
    expect(ov.runningInRecent).toEqual({ hasKey: true, lastMessageAt: ov.expected.running })
  },
)

dbTest('the OpenAPI document declares lastMessageAt as a required, nullable string', () => {
  const { status, withField } = fact<{
    status: number
    withField: { name: string; prop: Record<string, unknown>; required: boolean }[]
  }>('openapi')
  expect(status).toBe(200)
  expect(withField.length).toBeGreaterThan(0)
  for (const { name, prop, required } of withField) {
    expect([name, required]).toEqual([name, true])
    // OpenAPI 3.0 (`nullable: true`) or 3.1 (`type: ['string', 'null']`).
    const nullable =
      prop.nullable === true || (Array.isArray(prop.type) && prop.type.includes('null'))
    expect([name, nullable]).toEqual([name, true])
  }
})

// --- order -------------------------------------------------------------------

dbTest('the list is ordered by lastMessageAt ?? createdAt, then createdAt, newest first', () => {
  expect(fact<Order>('order').before.order).toEqual(EXPECTED_ORDER)
})

dbTest('a rename bumps updatedAt, keeps lastMessageAt, and answers it on the PATCH', () => {
  const { renames } = fact<Order>('order')
  for (const title of ['c-created-5d-spoke-3h', 'b-created-2h-no-messages', 'h-old-no-messages']) {
    const r = renames[title] as Record<string, unknown>
    expect(r.status).toBe(200)
    expect(r.patchTitle).toBe(`${title} (renamed)`)
    expect(r.patchHasKey).toBe(true)
    expect(r.updatedAtBumped).toBe(true)
    expect(r.patchLastMessageAt).toBe(r.priorLastMessageAt as string | null)
  }
  expect((renames['b-created-2h-no-messages'] as Record<string, unknown>).patchLastMessageAt).toBe(
    null,
  )
})

dbTest('a settings edit (maxBudgetUsd) bumps updatedAt and keeps lastMessageAt', () => {
  const r = fact<Order>('order').renames.budgetEdit as Record<string, unknown>
  expect(r.status).toBe(200)
  expect(r.updatedAtBumped).toBe(true)
  expect(r.patchLastMessageAt).toBe(r.priorLastMessageAt as string)
})

dbTest('renames and edits leave the list order and every lastMessageAt untouched', () => {
  const { before, afterRename } = fact<Order>('order')
  expect(afterRename.order).toEqual(EXPECTED_ORDER)
  expect(afterRename.lastMessageAt).toEqual(before.lastMessageAt)
})

dbTest('a newly queued prompt moves its session to the top', () => {
  const { afterSend } = fact<Order>('order')
  expect(afterSend.order[0]).toBe('b-created-2h-no-messages')
  expect(afterSend.lastMessageAt['b-created-2h-no-messages']).not.toBeNull()
  expect(afterSend.order.slice(1)).toEqual(
    EXPECTED_ORDER.filter((t) => t !== 'b-created-2h-no-messages'),
  )
})
