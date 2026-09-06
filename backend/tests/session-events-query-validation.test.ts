// The `after` half of /sessions/:id/events' hand-rolled validation, and whether
// the "one shape for every 400" invariant errors.ts claims actually holds
// across the three routes that sit outside the OpenAPI router.
//
// tests/api-error-envelope.test.ts pins the `:id` half — the same malformed id
// producing byte-identical bodies from /events and /messages. `after` is the
// half that is not merely a consistency nicety: the change made a non-finite
// `after` a 400 where it used to be silently coerced to -1 and answered with a
// full transcript replay. That is a behaviour change on a live wire format, so
// which values moved and which did not is worth stating exactly rather than
// sampling two of them.
//
// Same mounting trick as api-error-envelope.test.ts, and for the same reason:
// sessionsRouter under a parent carrying createApp()'s real defaultHook, so
// /messages is validated exactly as it is in production while /events runs its
// own hand-rolled check, and the two bodies can be compared for real.
import { expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

mock.module(`${B}/db/client.ts`, () => ({
  db: {
    select: () => ({
      from: (t: unknown) => ({
        where: () => ({
          limit: async () =>
            getTableName(t as Parameters<typeof getTableName>[0]) === 'sessions'
              ? [{ id: SESSION_ID }]
              : [],
          orderBy: async () => [],
        }),
      }),
    }),
  },
  closeDb: async () => {},
}))

mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
}))

const { sessionsRouter } = await import(`${B}/features/sessions/routes.ts`)
const { openApiValidationHook } = await import(`${B}/lib/openapi-hook.ts`)

const parent = new OpenAPIHono({ defaultHook: openApiValidationHook })
parent.route('/api', sessionsRouter)

/** Asks both routes the same question. /events answers a 200 with an endless
 *  stream, so its body is cancelled rather than read — reading it would hang
 *  the test rather than fail it. */
async function both(query: string) {
  const [events, messages] = await Promise.all([
    parent.request(`/api/sessions/${SESSION_ID}/events?${query}`),
    parent.request(`/api/sessions/${SESSION_ID}/messages?${query}`),
  ])
  const eventsBody = events.status === 400 ? await events.text() : null
  if (events.status !== 400) await events.body?.cancel()
  const messagesBody = messages.status === 400 ? await messages.text() : null
  return { events, messages, eventsBody, messagesBody }
}

// --- what is rejected, and identically on both routes -------------------------

// `NaN` and `1e999` are the two from the report; the rest are every other way a
// value can miss this schema, so a later change to `afterSchema` cannot quietly
// widen or narrow it on one route only.
for (const value of ['NaN', '1e999', 'Infinity', '-Infinity', 'abc', '1.5', '-2', 'true', '[]']) {
  test(`after=${value} is a 400 on both /events and /messages, with the same body`, async () => {
    const { events, messages, eventsBody, messagesBody } = await both(`after=${value}`)
    expect(events.status).toBe(400)
    expect(messages.status).toBe(400)
    expect(eventsBody).toBe(messagesBody)
    expect(JSON.parse(eventsBody ?? '{}')).toMatchObject({ error: 'Validation failed' })
  })
}

test('a rejected after names `after` as the offending field, not the id', async () => {
  const { eventsBody } = await both('after=NaN')
  const body = JSON.parse(eventsBody ?? '{}') as { issues?: { path: string }[] }
  expect(body.issues?.map((i) => i.path)).toEqual(['after'])
})

test('a malformed id and a malformed after are reported together, not one at a time', async () => {
  // Both parses run before either is thrown on, so a client fixing one does
  // not have to make a second round trip to discover the other.
  const res = await parent.request('/api/sessions/not-a-uuid/events?after=NaN')
  expect(res.status).toBe(400)
  const body = (await res.json()) as { issues?: { path: string }[] }
  expect(body.issues?.map((i) => i.path).sort()).toEqual(['after', 'id'])
})

// --- what is still accepted ----------------------------------------------------

// The reconnecting-client contract. -1 in particular is load-bearing: it is
// what use-session-stream.ts sends when the transcript cache is empty, and
// turning it into a 400 would break every first connection.
for (const value of ['-1', '0', '7']) {
  test(`after=${value} is still accepted on both routes`, async () => {
    const { events, messages } = await both(`after=${value}`)
    expect(events.status).toBe(200)
    expect(messages.status).toBe(200)
  })
}

test('after omitted entirely is accepted and means the same as after=-1', async () => {
  const res = await parent.request(`/api/sessions/${SESSION_ID}/events`)
  expect(res.status).toBe(200)
  await res.body?.cancel()
})

test('an empty after= is coerced to 0, not to -1 — it skips seq 0 rather than replaying all', async () => {
  // Not a regression (`Number('')` was 0 under the old hand-rolled parse too,
  // and /messages has always behaved this way), and no client in this repo
  // sends it. Pinned because it is the one input where "looks like nothing was
  // passed" and "was passed" disagree, and a future switch to
  // `z.coerce.number()` on a trimmed/nullish-coalesced value would flip it
  // silently.
  const { events, messages } = await both('after=')
  expect(events.status).toBe(200)
  expect(messages.status).toBe(200)
})

// --- the invariant that now holds everywhere -----------------------------------

// `validationFailed` (lib/errors.ts) exists so that a route outside the OpenAPI
// router rejects bad input in "exactly the shape app.ts's defaultHook builds",
// and its own docstring names the two routes it is for: "an SSE stream, a file
// download — see sessions/routes.ts". /export, the file download, used to
// throw `badRequest('Invalid session id')` instead, producing
// `{"error":"Invalid session id"}` — no `issues` array, and a different
// `error` string — for the identical malformed id that /events and /messages
// both answered with `{"error":"Validation failed","issues":[...]}`.
//
// Promoted from `test.failing` (matching the convention in
// frontend/tests/use-session-messages.test.tsx for stating an invariant ahead
// of the fix) now that /export goes through the same `idParam`/
// `validationFailed` path as /events. tests/api-error-envelope.test.ts pins
// the three-way comparison, including /messages; this keeps the
// export-vs-events pairing local to the file that already covers /events'
// hand-rolled validation.
test('/export rejects a malformed id in the same envelope /events does', async () => {
  const [exportRes, eventsRes] = await Promise.all([
    parent.request('/api/sessions/not-a-uuid/export'),
    parent.request('/api/sessions/not-a-uuid/events'),
  ])
  expect(exportRes.status).toBe(400)
  expect(eventsRes.status).toBe(400)
  expect(await exportRes.text()).toBe(await eventsRes.text())
})
