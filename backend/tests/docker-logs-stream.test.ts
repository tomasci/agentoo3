// buildContainerLogsStream is pure with respect to the daemon — it takes an
// already-open DockerStream and never spawns one itself (see its own comment
// in routes.ts for why), which is what lets this file drive it with a fake
// and never come near a real `docker logs` process.

import { afterEach, expect, mock, test } from 'bun:test'
import './setup-env'
import type { DockerStream, DockerStreamLine } from '../src/features/docker/cli'

const B = new URL('../src', import.meta.url).pathname

// routes.ts imports features/docker/service.ts, which imports from '@/queue'
// (and transitively, features/projects/service.ts's own enqueueProjectSetup)
// — unmocked, that constructs every real BullMQ Queue in queue/index.ts, each
// a live ioredis connection this file never starts a fake server for and
// never needs: nothing here exercises a route or a queued operation, only
// the pure SSE framing (buildContainerLogsStream) and the slot counter. Every
// export is stubbed, not only the two this file's own code path reaches, for
// the same reason docker-state.test.ts's identical mock gives in full:
// `mock.module` replaces this specifier for the whole test process, so a
// name missing here would be a `SyntaxError` for code that has nothing to do
// with this feature.
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  QUEUE_ATTACHMENTS_GC: 'attachments-gc',
  QUEUE_TURN_ENDED: 'turn-ended',
  QUEUE_TURN_RECONCILE: 'turn-reconcile',
  QUEUE_IDEA_PROMPT: 'idea-prompt',
  QUEUE_IDEA_HANDOFF_SWEEP: 'idea-handoff-sweep',
  QUEUE_DOCKER_OP: 'docker-op',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  attachmentsGcQueue: { getJobs: async () => [] },
  turnEndedQueue: {},
  turnReconcileQueue: {},
  ideaPromptQueue: {},
  ideaHandoffSweepQueue: {},
  dockerOpQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
  enqueueAttachmentsGc: async () => ({}),
  ensureAttachmentsGcSchedule: async () => {},
  enqueueTurnEnded: async () => ({}),
  enqueueTurnReconcile: async () => ({}),
  ensureTurnReconcileSchedule: async () => {},
  enqueueIdeaPrompt: async () => ({}),
  enqueueIdeaHandoffSweep: async () => ({}),
  ensureIdeaHandoffSweepSchedule: async () => {},
  enqueueDockerOp: async () => ({}),
}))

const {
  acquireLogStreamSlot,
  buildContainerLogsStream,
  MAX_LOG_STREAMS,
  releaseLogStreamSlot,
  resetLogStreamSlotsForTests,
} = await import(`${B}/features/docker/routes.ts`)

afterEach(() => {
  resetLogStreamSlotsForTests()
})

/** A DockerStream whose lines come from a fixed array, then hangs (like a
 * real `--follow` would) until the test cancels it. */
function fakeStream(lines: DockerStreamLine[]): DockerStream & { closed: boolean } {
  const state = { closed: false }
  return {
    get closed() {
      return state.closed
    },
    lines: (async function* () {
      for (const line of lines) yield line
      // Simulates --follow: never reaches EOF on its own.
      await new Promise(() => {})
    })(),
    close() {
      state.closed = true
    },
    exited: new Promise(() => {}), // never resolves; close()/cancel() is what ends this test
  }
}

async function readFrames(stream: ReadableStream<Uint8Array>, count: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const frames: { event: string; data: unknown }[] = []
  let buf = ''
  while (frames.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i = buf.indexOf('\n\n')
    while (i !== -1) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const event = raw.match(/^event: (.+)$/m)?.[1]
      const data = raw.match(/^data: (.+)$/m)?.[1]
      if (event && data) frames.push({ event, data: JSON.parse(data) })
      i = buf.indexOf('\n\n')
    }
  }
  return { reader, frames }
}

// --- framing ----------------------------------------------------------------

test('emits an open frame first, carrying containerId/tail/since', async () => {
  const docker = fakeStream([])
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 })
  const { reader, frames } = await readFrames(stream, 1)
  expect(frames[0]).toEqual({ event: 'open', data: { containerId: 'abc123', tail: 500, since: null } })
  await reader.cancel()
})

test('splits a --timestamps line into at and text', async () => {
  const docker = fakeStream([{ stream: 'stdout', line: '2024-01-01T00:00:00.000000000Z hello world' }])
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 })
  const { reader, frames } = await readFrames(stream, 2)
  expect(frames[1]).toEqual({
    event: 'log',
    data: { stream: 'stdout', at: '2024-01-01T00:00:00.000000000Z', text: 'hello world' },
  })
  await reader.cancel()
})

test('a line with no recognisable timestamp prefix keeps at: null', async () => {
  const docker = fakeStream([{ stream: 'stderr', line: 'not timestamped' }])
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 })
  const { reader, frames } = await readFrames(stream, 2)
  expect(frames[1]).toEqual({ event: 'log', data: { stream: 'stderr', at: null, text: 'not timestamped' } })
  await reader.cancel()
})

test('an over-long line is truncated rather than sent whole', async () => {
  const huge = 'x'.repeat(20_000)
  const docker = fakeStream([{ stream: 'stdout', line: huge }])
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 })
  const { reader, frames } = await readFrames(stream, 2)
  const text = (frames[1]?.data as { text: string }).text
  expect(text.length).toBeLessThan(huge.length)
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192)
  await reader.cancel()
})

// --- cancel() / close() ------------------------------------------------------

test('cancelling the reader calls DockerStream.close()', async () => {
  const docker = fakeStream([{ stream: 'stdout', line: 'hi' }])
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 })
  const reader = stream.getReader()
  await reader.read() // 'open'
  expect(docker.closed).toBe(false)
  await reader.cancel()
  expect(docker.closed).toBe(true)
})

test('onDone fires exactly once on cancel, for slot release', async () => {
  const docker = fakeStream([])
  let calls = 0
  const stream = buildContainerLogsStream(docker, { containerId: 'abc123', tail: 500 }, () => {
    calls += 1
  })
  const reader = stream.getReader()
  await reader.read() // 'open'
  await reader.cancel()
  await reader.cancel() // idempotent — a double cancel must not double-release
  expect(calls).toBe(1)
})

// --- the concurrent-stream cap ------------------------------------------------

test('acquireLogStreamSlot allows up to MAX_LOG_STREAMS concurrently, then refuses', () => {
  for (let i = 0; i < MAX_LOG_STREAMS; i++) {
    expect(acquireLogStreamSlot()).toBe(true)
  }
  expect(acquireLogStreamSlot()).toBe(false)
})

test('releasing a slot makes room for exactly one more', () => {
  for (let i = 0; i < MAX_LOG_STREAMS; i++) acquireLogStreamSlot()
  expect(acquireLogStreamSlot()).toBe(false)
  releaseLogStreamSlot()
  expect(acquireLogStreamSlot()).toBe(true)
  expect(acquireLogStreamSlot()).toBe(false)
})
