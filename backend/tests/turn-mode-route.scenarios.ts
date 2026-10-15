// POST /api/sessions/{id}/messages with and without `mode`, through the real
// router and the same validation hook createApp() installs — so this pins what
// the HTTP boundary accepts and what it hands the service, not just what the
// zod schema parses in isolation (turn-mode.test.ts covers that).
//
// A *.scenarios.ts file run by turn-mode-route.test.ts in its own process: it
// replaces the sessions service and the queue with mock.module, which in the
// shared `bun test tests/` process would reach every other file that imports
// them (see run-isolated.ts).

import { expect, mock, test } from 'bun:test'
import './setup-env'
import { OpenAPIHono } from '@hono/zod-openapi'

const B = new URL('../src', import.meta.url).pathname
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

/** Every (sessionId, text, mode) the route handed sendMessage — arguments as passed. */
const sent: unknown[][] = []

mock.module(`${B}/queue/index.ts`, () => ({
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
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
  enqueueLearningRun: async () => ({}),
}))

const realService = await import(`${B}/features/sessions/service.ts`)
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realService,
  sendMessage: async (...args: unknown[]) => {
    sent.push(args)
    const [, text, mode] = args as [string, string, string | undefined]
    return {
      id: '22222222-2222-4222-8222-222222222222',
      seq: 1,
      type: 'prompt',
      title: null,
      pending: true,
      payload: mode === 'qa' ? { text, mode } : { text },
      agent: null,
      createdAt: new Date().toISOString(),
      files: [],
    }
  },
}))

const { sessionsRouter } = await import(`${B}/features/sessions/routes.ts`)
const { openApiValidationHook } = await import(`${B}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', sessionsRouter)

/** A call as the service sees it: an omitted mode is sendMessage's own default, Code. */
const asCall = ([id, text, mode]: unknown[]) => [id, text, mode ?? 'code']

const post = (body: unknown) =>
  app.request(`/api/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a body of just { text } is accepted and reaches the service as Code', async () => {
  sent.length = 0
  const res = await post({ text: 'refactor the loader' })
  expect(res.status).toBe(201)
  expect(sent.map(asCall)).toEqual([[SESSION_ID, 'refactor the loader', 'code']])
})

test("mode 'code' is accepted and reaches the service as Code", async () => {
  sent.length = 0
  const res = await post({ text: 'refactor the loader', mode: 'code' })
  expect(res.status).toBe(201)
  expect(sent.map(asCall)).toEqual([[SESSION_ID, 'refactor the loader', 'code']])
})

test("mode 'qa' is accepted and reaches the service as Q&A, text untouched", async () => {
  sent.length = 0
  const res = await post({ text: '  why does it retry?\n', mode: 'qa' })
  expect(res.status).toBe(201)
  expect(sent).toEqual([[SESSION_ID, '  why does it retry?\n', 'qa']])
  const body = (await res.json()) as { payload: unknown }
  expect(body.payload).toEqual({ text: '  why does it retry?\n', mode: 'qa' })
})

for (const mode of ['plan', 'QA', 'Q&A', '', null, 1, ['qa']]) {
  test(`mode ${JSON.stringify(mode)} is a 400 in the API's validation envelope, and nothing is sent`, async () => {
    sent.length = 0
    const res = await post({ text: 'hello', mode })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: { path: string; message: string }[] }
    expect(body.error).toBe('Validation failed')
    expect(body.issues.map((i) => i.path)).toEqual(['mode'])
    expect(body.issues[0]?.message.length).toBeGreaterThan(0)
    expect(sent).toEqual([])
  })
}

test('an invalid mode alongside a missing text reports both fields, and nothing is sent', async () => {
  sent.length = 0
  const res = await post({ mode: 'plan' })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { issues: { path: string }[] }
  expect(body.issues.map((i) => i.path).sort()).toEqual(['mode', 'text'])
  expect(sent).toEqual([])
})
