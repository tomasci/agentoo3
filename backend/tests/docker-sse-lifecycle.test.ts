// The container-logs SSE body's lifecycle: what happens on client disconnect,
// on the child exiting on its own, on an error mid-stream — and whether the
// MAX_LOG_STREAMS counter survives all three.
//
// docker-logs-stream.test.ts covers the framing (open/log/end shapes) and the
// counter in isolation. This file is the independent pass over the parts that
// only show up when the two are combined: a slot acquired by the route and
// released by the body, exercised over more cycles than the cap allows, and
// the termination of the response itself.
//
// Only `@/queue/index.ts` is mocked (routes.ts reaches it transitively through
// service.ts, which would otherwise construct live BullMQ connections); the
// module under test is imported for real.

import { afterEach, expect, mock, test } from 'bun:test'
import './setup-env'
import type { DockerStream, DockerStreamLine } from '../src/features/docker/cli'

const B = new URL('../src', import.meta.url).pathname

mock.module(`${B}/queue/index.ts`, () => ({
  // Additive stub for features/editor -- not exercised here, kept only so
  // this hard-coded (non-spread) mock does not remove it from the shared
  // module for whichever other test file imports it while this mock is live.
  enqueueEditorStart: async () => ({}),
  enqueueEditorReap: async () => ({}),
  ensureEditorReapSchedule: async () => {},
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

const META = { containerId: 'a'.repeat(64), tail: 500 }

/** A stream that yields its lines and then ends, the way a `docker logs`
 *  against an already-exited container does (it does not wait for a container
 *  that will never write again). */
function finiteStream(lines: DockerStreamLine[], exitCode = 0): DockerStream & { closed: number } {
  const state = { closed: 0 }
  return {
    get closed() {
      return state.closed
    },
    lines: (async function* () {
      for (const line of lines) yield line
    })(),
    close() {
      state.closed += 1
    },
    exited: Promise.resolve(exitCode),
  }
}

/** A stream that hangs after its lines, the way `--follow` against a running
 *  container does — only a cancel ends it. */
function followingStream(lines: DockerStreamLine[]): DockerStream & { closed: number } {
  const state = { closed: 0 }
  return {
    get closed() {
      return state.closed
    },
    lines: (async function* () {
      for (const line of lines) yield line
      await new Promise(() => {})
    })(),
    close() {
      state.closed += 1
    },
    exited: new Promise(() => {}),
  }
}

async function readFrames(body: ReadableStream<Uint8Array>, count: number) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames: { event: string; data: Record<string, unknown> }[] = []
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

/** Exactly what the route does around the body: take a slot, release it once
 *  the body is done — see routes.ts's `release` closure. */
function openLikeTheRoute(stream: DockerStream) {
  if (!acquireLogStreamSlot()) throw new Error('no slot')
  let released = false
  const body = buildContainerLogsStream(stream, META, () => {
    if (released) return
    released = true
    releaseLogStreamSlot()
  })
  return body
}

/** How many slots are free right now, leaving the counter as it found it. */
function freeSlots(): number {
  let taken = 0
  while (acquireLogStreamSlot()) taken += 1
  for (let i = 0; i < taken; i++) releaseLogStreamSlot()
  return taken
}

// --- termination -----------------------------------------------------------------

test('a client that disconnects kills the docker child exactly once', async () => {
  const stream = followingStream([{ stream: 'stdout', line: 'x' }])
  const body = openLikeTheRoute(stream)
  const { reader } = await readFrames(body, 2)
  await reader.cancel()
  expect(stream.closed).toBe(1)
})

test('the response body ends once the docker child has exited', async () => {
  // `docker logs --follow` against a container that has already exited returns
  // immediately, and so does `docker logs` when the binary is missing (the
  // spawn-failure stream cli.ts returns exits with -127 straight away). The
  // body must finish so the client sees EOF rather than an open socket that
  // will never carry another byte.
  const stream = finiteStream([{ stream: 'stdout', line: '2024-05-01T10:00:00Z bye' }], 0)
  const body = buildContainerLogsStream(stream, META)
  const { reader, frames } = await readFrames(body, 3)
  expect(frames.map((f) => f.event)).toEqual(['open', 'log', 'end'])
  expect(frames[2]?.data).toEqual({ reason: 'eof', message: null })

  const closed = await Promise.race([
    reader.read().then((r) => (r.done ? 'closed' : 'more data')),
    new Promise((resolve) => setTimeout(() => resolve('still open'), 250)),
  ])
  expect(closed).toBe('closed')
})

test('a non-zero docker logs exit is reported as an "exited" end frame', async () => {
  const stream = finiteStream([], 1)
  const body = buildContainerLogsStream(stream, META)
  const { reader, frames } = await readFrames(body, 2)
  await reader.cancel()
  expect(frames[1]).toEqual({
    event: 'end',
    data: { reason: 'exited', message: 'docker logs exited with code 1' },
  })
})

test('an error thrown by the line iterator ends the stream instead of rejecting', async () => {
  const stream: DockerStream = {
    lines: (async function* () {
      yield { stream: 'stdout' as const, line: 'one' }
      throw new Error('pipe collapsed')
    })(),
    close() {},
    exited: Promise.resolve(0),
  }
  const body = buildContainerLogsStream(stream, META)
  const { reader, frames } = await readFrames(body, 3)
  await reader.cancel()
  expect(frames[2]).toEqual({ event: 'end', data: { reason: 'error', message: 'pipe collapsed' } })
})

// --- the concurrency cap over many cycles -----------------------------------------

test('opening and abandoning far more streams than the cap never consumes it permanently', async () => {
  for (let i = 0; i < MAX_LOG_STREAMS * 3; i++) {
    const stream = followingStream([{ stream: 'stdout', line: `line ${i}` }])
    const body = openLikeTheRoute(stream)
    const { reader } = await readFrames(body, 2)
    await reader.cancel()
    expect(stream.closed).toBe(1)
  }
  expect(freeSlots()).toBe(MAX_LOG_STREAMS)
})

test('a stream that errors out releases its slot', async () => {
  const body = openLikeTheRoute({
    lines: (async function* () {
      throw new Error('boom')
    })(),
    close() {},
    exited: Promise.resolve(0),
  })
  const { reader } = await readFrames(body, 2)
  await reader.cancel()
  expect(freeSlots()).toBe(MAX_LOG_STREAMS)
})

test('a stream whose child exits on its own releases its slot', async () => {
  const body = openLikeTheRoute(finiteStream([{ stream: 'stdout', line: 'done' }], 0))
  const { reader } = await readFrames(body, 3)
  await reader.cancel()
  expect(freeSlots()).toBe(MAX_LOG_STREAMS)
})

test('a body that is never read at all still releases its slot once cancelled', async () => {
  const stream = followingStream([])
  const body = openLikeTheRoute(stream)
  await body.cancel()
  expect(stream.closed).toBe(1)
  expect(freeSlots()).toBe(MAX_LOG_STREAMS)
})

test('the cap refuses the ninth concurrent stream and admits it again once one ends', async () => {
  const open: { reader: ReadableStreamDefaultReader<Uint8Array>; stream: DockerStream }[] = []
  for (let i = 0; i < MAX_LOG_STREAMS; i++) {
    const stream = followingStream([{ stream: 'stdout', line: 'x' }])
    const body = openLikeTheRoute(stream)
    const { reader } = await readFrames(body, 2)
    open.push({ reader, stream })
  }
  expect(acquireLogStreamSlot()).toBe(false)
  await open[0]?.reader.cancel()
  expect(acquireLogStreamSlot()).toBe(true)
  releaseLogStreamSlot()
  for (const { reader } of open.slice(1)) await reader.cancel()
})

// --- truncation and dropped-line accounting ----------------------------------------

test('a line is truncated to the 8192-byte cap, not passed through whole', async () => {
  const body = buildContainerLogsStream(
    finiteStream([{ stream: 'stdout', line: 'a'.repeat(10_000) }]),
    META,
  )
  const { reader, frames } = await readFrames(body, 2)
  await reader.cancel()
  const text = (frames[1]?.data as { text: string }).text
  expect(text).toHaveLength(8192)
})

test('truncating in the middle of a multi-byte character does not throw or blow the cap open', async () => {
  // 8190 ASCII bytes then a 3-byte character that straddles the boundary.
  const line = `${'a'.repeat(8190)}${'€'.repeat(10)}`
  const body = buildContainerLogsStream(finiteStream([{ stream: 'stdout', line }]), META)
  const { reader, frames } = await readFrames(body, 2)
  await reader.cancel()
  const text = (frames[1]?.data as { text: string }).text
  // The replacement character for the split byte may round the encoded length
  // up slightly; what matters is that it is bounded, not that it is exact.
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192 + 3)
  expect(text.startsWith('a'.repeat(8190))).toBe(true)
})

test('a burst beyond the per-second cap reports exactly how many lines it dropped', async () => {
  const lines: DockerStreamLine[] = Array.from({ length: 2_500 }, (_, i) => ({
    stream: 'stdout' as const,
    line: `line ${i}`,
  }))
  const body = buildContainerLogsStream(finiteStream(lines), META)
  const { reader, frames } = await readFrames(body, 2_003)
  await reader.cancel()
  const logs = frames.filter((f) => f.event === 'log')
  const dropped = frames.filter((f) => f.event === 'dropped')
  expect(logs).toHaveLength(2_000)
  expect(dropped).toHaveLength(1)
  expect(dropped[0]?.data).toEqual({ lines: 500 })
  // The frames that did get through are the first 2000, in order.
  expect((logs[0]?.data as { text: string }).text).toBe('line 0')
  expect((logs[1_999]?.data as { text: string }).text).toBe('line 1999')
})

test('a timestamp-prefixed line is split into at and text, and a multi-line payload keeps its newlines', async () => {
  const body = buildContainerLogsStream(
    finiteStream([{ stream: 'stderr', line: '2024-05-01T10:00:00.123456789Z panic:\n  at main' }]),
    META,
  )
  const { reader, frames } = await readFrames(body, 2)
  await reader.cancel()
  expect(frames[1]?.data).toEqual({
    stream: 'stderr',
    at: '2024-05-01T10:00:00.123456789Z',
    text: 'panic:\n  at main',
  })
})
