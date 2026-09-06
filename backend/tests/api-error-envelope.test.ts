// GET /sessions/:id/events lives outside the OpenAPI router (see the
// docstring on it in sessions/routes.ts) and so never got the automatic param
// validation every OpenAPI-declared route does — a malformed id reached the
// database as a literal string and came back as a generic 500.
//
// This mounts sessionsRouter under a parent OpenAPIHono configured with
// exactly the hook createApp() uses (openApiValidationHook, lib/openapi-hook.ts)
// rather than booting the whole app: every other feature router app.ts also
// mounts pulls in its own real dependencies this suite otherwise avoids
// touching, and none of it is what this file is about — only whether /events,
// /export and /messages agree on one 400 shape.
import { expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

// Only ever exercises listMessages' own two selects (sessions, then
// messages/message_files) — a session that exists, with an empty transcript,
// is what makes the well-formed-id case below a 200 with a real stream rather
// than a 404 that would prove nothing about the validation this file is for.
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

// /export is a third route living outside the OpenAPI router (see its
// docstring in sessions/routes.ts) that used to throw a route-local
// `badRequest` instead of going through `validationFailed` like /events and
// /messages, so a malformed id 400ed with a differently-shaped body only
// there. Comparing all three bodies directly — rather than each against a
// hardcoded literal — is what actually catches that: a future change to the
// shared envelope that all three routes track together would pass three
// separate "equals this literal" assertions just as easily as it broke them.
test('/export, /events and /messages 400 on the same malformed id with byte-identical bodies', async () => {
  const [exportRes, eventsRes, messagesRes] = await Promise.all([
    parent.request('/api/sessions/not-a-uuid/export'),
    parent.request('/api/sessions/not-a-uuid/events'),
    parent.request('/api/sessions/not-a-uuid/messages'),
  ])

  expect(exportRes.status).toBe(400)
  expect(eventsRes.status).toBe(400)
  expect(messagesRes.status).toBe(400)

  const [exportBody, eventsBody, messagesBody] = await Promise.all([
    exportRes.text(),
    eventsRes.text(),
    messagesRes.text(),
  ])
  expect(exportBody).toBe(eventsBody)
  expect(eventsBody).toBe(messagesBody)
  expect(JSON.parse(eventsBody)).toEqual({
    error: 'Validation failed',
    issues: [{ path: 'id', message: 'Invalid UUID' }],
  })
})

// A sample from the report this fixes: none of these are valid UUIDs, and all
// of them reached the database directly before this fix.
for (const id of ['123', 'abc-def', '%20', '00000000-0000-4000-8000-00000000000Z']) {
  test(`/events 400s on the malformed id ${JSON.stringify(id)} instead of 500ing`, async () => {
    const res = await parent.request(`/api/sessions/${id}/events`)
    expect(res.status).toBe(400)
  })
}

test('/events opens a real stream for a well-formed, if unknown, id', async () => {
  // Not a 404: listMessages (and thus an unknown session) only runs once
  // validation passes, and this file's fake db answers the sessions lookup
  // with a row — the 404-vs-500 boundary for a truly unknown id is
  // service.ts's concern (see session-messages.test.ts's "an unknown session
  // id is a 404"), not this route's hand-rolled param validation, which is
  // what this file's :id-shaped focus is actually about.
  const res = await parent.request(`/api/sessions/${SESSION_ID}/events`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
})
