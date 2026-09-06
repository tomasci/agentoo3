import { afterAll, expect, mock, test } from 'bun:test'
import { FAKE_REDIS_PORT } from './setup-env'
import { startFakeRedis } from './fake-redis'

const PORT = FAKE_REDIS_PORT

// Started before the import below: the events module pulls in the BullMQ
// queues, which connect to Redis the moment they are constructed.
const redis = startFakeRedis(PORT)
afterAll(() => redis.stop())

const B = new URL('../src', import.meta.url).pathname
const events = await import('../src/lib/events')

const settle = () => new Promise((r) => setTimeout(r, 120))

// --- the bus ------------------------------------------------------------------

test('a published message reaches a subscriber of that session', async () => {
  const got: unknown[] = []
  const off = events.subscribeSession('sess-a', (e) => got.push(e))
  await settle()

  await events.publishSessionEvent({ kind: 'message', sessionId: 'sess-a', seq: 7, message: { hi: 1 } })
  await settle()

  expect(got).toEqual([{ kind: 'message', sessionId: 'sess-a', seq: 7, message: { hi: 1 } }])
  off()
})

test('sessions are isolated from one another', async () => {
  const a: unknown[] = []
  const b: unknown[] = []
  const offA = events.subscribeSession('sess-1', (e) => a.push(e))
  const offB = events.subscribeSession('sess-2', (e) => b.push(e))
  await settle()

  await events.publishSessionEvent({ kind: 'status', sessionId: 'sess-1', status: 'running' })
  await settle()

  expect(a.length).toBe(1)
  expect(b.length).toBe(0)
  offA(); offB()
})

test('control events use their own channel, not the transcript one', async () => {
  const transcript: unknown[] = []
  const control: unknown[] = []
  const off1 = events.subscribeSession('sess-c', (e) => transcript.push(e))
  const off2 = events.subscribeControl('sess-c', (e) => control.push(e))
  await settle()

  await events.publishControl('sess-c', { kind: 'interrupt' })
  await settle()

  expect(control).toEqual([{ kind: 'interrupt' }])
  expect(transcript.length).toBe(0)
  off1(); off2()
})

test('unsubscribing stops delivery', async () => {
  const got: unknown[] = []
  const off = events.subscribeSession('sess-d', (e) => got.push(e))
  await settle()
  off()
  await settle()

  await events.publishSessionEvent({ kind: 'status', sessionId: 'sess-d', status: 'completed' })
  await settle()
  expect(got.length).toBe(0)
})

// --- the stream on top of it --------------------------------------------------

// A real UUID, not the short hand-picked ids the bus tests above use: /events
// now validates :id against the same schema /messages does (see
// sessions/routes.ts), so exercising it over HTTP needs an id that schema
// actually accepts.
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

const backlog = [
  { id: 'm1', sessionId: SESSION_ID, seq: 0, type: 'prompt', title: null, payload: { text: 'hi' } },
  {
    id: 'm2',
    sessionId: SESSION_ID,
    seq: 1,
    type: 'assistant',
    title: 'orchestrator: on it',
    payload: {},
  },
]
// Forwarded, not hand-rolled: resolving the real module *before* mock.module
// runs is what keeps this registration from racing another file's real
// `import()` of the same specifier — mock.module swaps the whole namespace
// for the specifier process-wide (see bun's own docs), and if this file
// registered a stub for it before the real module had ever been loaded
// anywhere, whichever other file imports it "for real" afterwards (e.g.
// session-messages.test.ts, exercising real pagination logic against its own
// fake db) could be served *this* stub instead of the genuine implementation
// it needs. Awaiting the real module first, then spreading it, means every
// export this file does not care about keeps working correctly for whoever
// else's import resolves to this registration.
const realService = await import(`${B}/features/sessions/service.ts`)
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realService,
  listMessages: async (_id: string, after: number) => backlog.filter((m) => m.seq > after),
}))

const { sessionsRouter } = await import(`${B}/features/sessions/routes.ts`)

const server = Bun.serve({ port: 0, idleTimeout: 60, fetch: (req) => sessionsRouter.fetch(req) })
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

/** Read SSE frames until `want` of them have arrived, or we time out. */
async function readFrames(body: ReadableStream<Uint8Array>, want: number, ms = 3000) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames: { event: string; data: unknown }[] = []
  let buf = ''
  const deadline = Date.now() + ms
  while (frames.length < want && Date.now() < deadline) {
    // read() never resolves on a quiet stream, so the deadline has to race it
    // rather than be checked after it returns.
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
    ])
    if (next === null) break
    const { value, done } = next
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const event = raw.match(/^event: (.+)$/m)?.[1]
      const data = raw.match(/^data: (.+)$/m)?.[1]
      if (event && data) frames.push({ event, data: JSON.parse(data) })
    }
  }
  void reader.cancel()
  return frames
}

test('the stream replays history before going live', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  // Without this nginx buffers the whole stream and the browser sees nothing.
  expect(res.headers.get('x-accel-buffering')).toBe('no')

  const frames = await readFrames(res.body!, 2)
  expect(frames.map((f) => f.event)).toEqual(['message', 'message'])
  expect((frames[0]!.data as { message: { seq: number } }).message.seq).toBe(0)
  expect((frames[1]!.data as { message: { seq: number } }).message.seq).toBe(1)
})

test('after= skips what the client already has', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=0`)
  const frames = await readFrames(res.body!, 1)
  expect(frames.length).toBe(1)
  expect((frames[0]!.data as { message: { seq: number } }).message.seq).toBe(1)
})

test('an event published after connecting arrives live', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=1`)
  const pending = readFrames(res.body!, 1)
  // Let the subscription land before publishing into it.
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({
    kind: 'message', sessionId: SESSION_ID, seq: 2, message: { id: 'm3', seq: 2, title: 'live' },
  })
  const frames = await pending
  expect(frames.length).toBe(1)
  expect(frames[0]!.event).toBe('message')
  expect((frames[0]!.data as { message: { title: string } }).message.title).toBe('live')
})

test('status changes come through as their own event type', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=1`)
  const pending = readFrames(res.body!, 1)
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({ kind: 'status', sessionId: SESSION_ID, status: 'running' })
  const frames = await pending
  expect(frames[0]!.event).toBe('status')
  expect((frames[0]!.data as { status: string }).status).toBe('running')
})

test('one session does not receive another session events', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=1`)
  const pending = readFrames(res.body!, 1, 1200)
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({ kind: 'status', sessionId: 'other', status: 'running' })
  const frames = await pending
  expect(frames.length).toBe(0)
})

// --- validation -----------------------------------------------------------------
//
// :id and after used to reach listMessages/the database unchecked — a
// malformed id surfaced as a 500 (see api-error-envelope.test.ts for the 400
// this now is, and that it matches /messages' own body), and a non-finite
// after silently replayed the whole transcript instead of being rejected.

test('a malformed session id is a 400, not a 500', async () => {
  const res = await fetch(`${base}/sessions/not-a-uuid/events`)
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error: string; issues?: unknown }
  expect(body.error).toBe('Validation failed')
  expect(body.issues).toEqual([{ path: 'id', message: 'Invalid UUID' }])
})

test('after=-1 is the legitimate "replay everything" case a reconnecting client with an empty cache relies on', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=-1`)
  expect(res.status).toBe(200)
  const frames = await readFrames(res.body!, 2)
  expect(frames.map((f) => f.event)).toEqual(['message', 'message'])
})

test('after=NaN is rejected with a 400 rather than silently replaying everything', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=NaN`)
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error: string; issues?: { path: string }[] }
  expect(body.error).toBe('Validation failed')
  expect(body.issues?.[0]?.path).toBe('after')
})

test('an after so large it parses to Infinity is rejected, not treated as -1', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/events?after=1e999`)
  expect(res.status).toBe(400)
})

// --- failure ------------------------------------------------------------------
// Last: it stops the server the tests above depend on.

test('a publish failure never throws into the caller', async () => {
  redis.stop()
  await settle()
  // The run must survive Redis going away: the row is already committed.
  await events.publishSessionEvent({ kind: 'status', sessionId: 'sess-e', status: 'failed' })
  expect(true).toBe(true)
})
