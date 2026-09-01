import { afterAll, expect, mock, test } from 'bun:test'
import { startFakeRedis } from './fake-redis'

const PORT = 6399
process.env.REDIS_URL = `redis://127.0.0.1:${PORT}`
process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/db'

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

const backlog = [
  { id: 'm1', sessionId: 's1', seq: 0, type: 'prompt', title: null, payload: { text: 'hi' } },
  { id: 'm2', sessionId: 's1', seq: 1, type: 'assistant', title: 'orchestrator: on it', payload: {} },
]
mock.module(`${B}/features/sessions/service.ts`, () => ({
  listMessages: async (_id: string, after: number) => backlog.filter((m) => m.seq > after),
  listSessions: async () => [], getSession: async () => ({}), createSession: async () => ({}),
  updateSession: async () => ({}), deleteSession: async () => {},
  sendMessage: async () => ({}), interruptSession: async () => ({}),
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
  const res = await fetch(`${base}/sessions/s1/events`)
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
  const res = await fetch(`${base}/sessions/s1/events?after=0`)
  const frames = await readFrames(res.body!, 1)
  expect(frames.length).toBe(1)
  expect((frames[0]!.data as { message: { seq: number } }).message.seq).toBe(1)
})

test('an event published after connecting arrives live', async () => {
  const res = await fetch(`${base}/sessions/s1/events?after=1`)
  const pending = readFrames(res.body!, 1)
  // Let the subscription land before publishing into it.
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({
    kind: 'message', sessionId: 's1', seq: 2, message: { id: 'm3', seq: 2, title: 'live' },
  })
  const frames = await pending
  expect(frames.length).toBe(1)
  expect(frames[0]!.event).toBe('message')
  expect((frames[0]!.data as { message: { title: string } }).message.title).toBe('live')
})

test('status changes come through as their own event type', async () => {
  const res = await fetch(`${base}/sessions/s1/events?after=1`)
  const pending = readFrames(res.body!, 1)
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({ kind: 'status', sessionId: 's1', status: 'running' })
  const frames = await pending
  expect(frames[0]!.event).toBe('status')
  expect((frames[0]!.data as { status: string }).status).toBe('running')
})

test('one session does not receive another session events', async () => {
  const res = await fetch(`${base}/sessions/s1/events?after=1`)
  const pending = readFrames(res.body!, 1, 1200)
  await new Promise((r) => setTimeout(r, 300))
  await events.publishSessionEvent({ kind: 'status', sessionId: 'other', status: 'running' })
  const frames = await pending
  expect(frames.length).toBe(0)
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
