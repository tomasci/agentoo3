// The shipped docker skill's CLI (library.example/skills/docker/docker.ts)
// against a fake of this app's own SSE route.
//
// The frames below are copied from backend/src/features/docker/routes.ts's
// operation-events route (the `retry: 3000\n: connected\n\n` priming write,
// `event: <name>\ndata: <json>\n\n` pairs, the 20s `: ping\n\n` heartbeat) and
// from operations.ts's own event payloads — not invented. A real backend is
// never touched: every mutating path here would otherwise move shared state.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'bun:test'

// The *real* request validators the route uses, so a body docker.ts sends is
// checked against the same schema the API would check it against — not
// against a hand-copied idea of it. `@hono/zod-openapi` first, deliberately:
// it installs the `.openapi()` method schema.ts calls at module scope, so
// importing schema.ts on its own throws (see docker-operations.test.ts).
await import('@hono/zod-openapi')
const { downRequestSchema, serviceSelectionSchema, upRequestSchema } = await import(
  '../src/features/docker/schema'
)

const SKILL = join(import.meta.dir, '..', '..', 'library.example', 'skills', 'docker', 'docker.ts')

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

/** One SSE frame, exactly as the route writes it. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const PRIMING = 'retry: 3000\n: connected\n\n'
const PING = ': ping\n\n'

const OPERATION_FRAME = frame('operation', {
  id: 'op-1',
  status: 'running',
  exitCode: null,
  error: null,
})

function outputFrame(seq: number, stream: 'stdout' | 'stderr', text: string): string {
  return frame('output', { kind: 'output', seq, stream, text, at: '2026-01-01T00:00:00.000Z' })
}

const STATE = {
  daemon: { cliInstalled: true, available: true, version: '27.0.0' },
  detection: { hasCompose: true, hasDockerfile: false },
  configError: null,
  services: [{ name: 'web', state: 'running' }],
  containers: [
    {
      name: 'proj-web-1',
      service: 'web',
      state: 'running',
      health: 'healthy',
      // The same hostPort twice is what docker actually reports for a port
      // bound on 0.0.0.0 and ::; the dedupe in containerAddressLines is what
      // this exercises.
      ports: [{ hostPort: 20030 }, { hostPort: 20030 }],
    },
  ],
  hosts: [{ label: 'tailscale', host: 'box.ts.net' }],
  activeOperationId: null,
}

/** What the next operation-events connection should stream, set per test. */
type Scenario = 'succeeded' | 'failed' | 'no-terminal-frame'
let scenario: Scenario = 'succeeded'
/** Every request path+query the skill sent, in order, for the scope assertions. */
let seenUrls: string[] = []
/** The `error` field the GET-one-operation route reports on the failure path. */
const OPERATION_ERROR = 'compose exited 1'
/** When set, the events route streams exactly these bytes instead of `scenario`. */
let rawStream: string[] | null = null
/** When set, the events route answers this status with a JSON error envelope. */
let eventsStatus: number | null = null
/** When set, POST up/stop/restart/down answers this status + envelope. */
let postFailure: { status: number; body: unknown } | null = null
/** When set, the events route answers with this raw (non-JSON) body + status. */
let rawPostResponse: { status: number; body: string; contentType: string } | null = null
/** Every mutation body the skill posted, and whether the real schema accepts it. */
let postedBodies: { kind: string; body: unknown; valid: boolean; issues: string }[] = []

function validateBody(kind: string, body: unknown): { valid: boolean; issues: string } {
  const schema =
    kind === 'up' ? upRequestSchema : kind === 'down' ? downRequestSchema : serviceSelectionSchema
  const parsed = schema.safeParse(body)
  return {
    valid: parsed.success,
    issues: parsed.success ? '' : JSON.stringify(parsed.error.issues),
  }
}

let server: ReturnType<typeof Bun.serve>
let base: string

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seenUrls.push(url.pathname + url.search)

      if (url.pathname.endsWith('/events')) {
        if (eventsStatus !== null) {
          return Response.json({ error: 'Operation not found' }, { status: eventsStatus })
        }
        if (rawStream !== null) {
          const chunks = rawStream
          const body = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder()
              for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
              controller.close()
            },
          })
          return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        }
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            const send = (s: string) => controller.enqueue(enc.encode(s))
            send(PRIMING)
            send(OPERATION_FRAME)
            send(outputFrame(0, 'stdout', 'Container proj-web-1  Started'))
            send(PING)
            send(outputFrame(1, 'stderr', 'time="..." level=warning msg="orphan"'))
            if (scenario === 'succeeded') {
              send(frame('end', { operationId: 'op-1', status: 'succeeded', exitCode: 0 }))
            } else if (scenario === 'failed') {
              send(frame('end', { operationId: 'op-1', status: 'failed', exitCode: 1 }))
            }
            // 'no-terminal-frame': the stream just ends here.
            controller.close()
          },
        })
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // GET one operation — the failure path's structured-error lookup.
      if (/\/docker\/operations\/[^/]+$/.test(url.pathname)) {
        return Response.json({
          id: 'op-1',
          status: scenario === 'failed' ? 'failed' : 'succeeded',
          exitCode: scenario === 'failed' ? 1 : 0,
          error: scenario === 'failed' ? OPERATION_ERROR : null,
        })
      }

      // POST up/stop/restart/down.
      const mutation = url.pathname.match(/\/docker\/(up|stop|restart|down)$/)
      if (mutation?.[1]) {
        const kind = mutation[1]
        const body: unknown = await req.json()
        postedBodies.push({ kind, body, ...validateBody(kind, body) })
        if (rawPostResponse !== null) {
          return new Response(rawPostResponse.body, {
            status: rawPostResponse.status,
            headers: { 'Content-Type': rawPostResponse.contentType },
          })
        }
        if (postFailure !== null) {
          return Response.json(postFailure.body, { status: postFailure.status })
        }
        return Response.json({ id: 'op-1', status: 'queued', exitCode: null, error: null })
      }

      // GET state.
      if (url.pathname.endsWith('/docker')) return Response.json(STATE)

      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}/api`
})

afterAll(() => {
  server.stop(true)
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function resetServer(): void {
  rawStream = null
  eventsStatus = null
  postFailure = null
  rawPostResponse = null
  seenUrls = []
  postedBodies = []
}

async function runSkill(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<Run> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    AGENTOO_API_BASE: base,
    AGENTOO_PROJECT_ID: PROJECT_ID,
  }
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const proc = Bun.spawn(['bun', SKILL, ...args], {
    cwd: cwd ?? import.meta.dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

// --- Seam 2: the mutating paths, none of which had ever been run ----------

test('up: a succeeded operation streams output, prints addresses, and exits 0', async () => {
  scenario = 'succeeded'
  seenUrls = []
  const run = await runSkill(['up', '--build', 'web'])

  expect(run.stderr).not.toContain('docker skill:')
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('up queued — operation op-1')
  // The stdout output frame, printed verbatim.
  expect(run.stdout).toContain('Container proj-web-1  Started')
  // The stderr output frame went to stderr, not stdout.
  expect(run.stdout).not.toContain('level=warning')
  expect(run.stderr).toContain('level=warning')
  // The succeeded -> addresses tail.
  expect(run.stdout).toContain('published addresses:')
  expect(run.stdout).toContain('proj-web-1 (web):')
  expect(run.stdout).toContain('tailscale: http://box.ts.net:20030')
  // Deduped: the doubled hostPort renders once.
  expect(run.stdout.split('tailscale: http://box.ts.net:20030').length - 1).toBe(1)
})

test('up: a failed operation reports the structured error and exits 1', async () => {
  scenario = 'failed'
  seenUrls = []
  const run = await runSkill(['up'])

  expect(run.code).toBe(1)
  expect(run.stderr).toContain(`up failed (operation op-1): ${OPERATION_ERROR}`)
  // No addresses tail on failure.
  expect(run.stdout).not.toContain('published addresses:')
  // It still streamed the output it did get before the failure.
  expect(run.stdout).toContain('Container proj-web-1  Started')
})

test('up: a stream that ends with no terminal frame is a reported failure, exit 1', async () => {
  scenario = 'no-terminal-frame'
  seenUrls = []
  const run = await runSkill(['up'])

  expect(run.code).toBe(1)
  expect(run.stderr).toContain('ended before the operation reached a terminal status')
  expect(run.stdout).not.toContain('published addresses:')
})

test('stop/restart/down take the same succeeded path and exit 0 without an addresses tail', async () => {
  scenario = 'succeeded'
  for (const kind of ['stop', 'restart', 'down'] as const) {
    seenUrls = []
    const run = await runSkill([kind])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`${kind} queued — operation op-1`)
    // Only `up` prints addresses.
    expect(run.stdout).not.toContain('published addresses:')
  }
})

// --- Seam 6: repo scope vs worktree scope --------------------------------

test('with no AGENTOO_SESSION_ID every request omits ?sessionId= entirely', async () => {
  scenario = 'succeeded'
  seenUrls = []
  const run = await runSkill(['up'], { AGENTOO_SESSION_ID: undefined })
  expect(run.code).toBe(0)
  expect(seenUrls.length).toBeGreaterThan(0)
  for (const u of seenUrls) expect(u).not.toContain('sessionId')
})

test('an empty AGENTOO_SESSION_ID also omits the param — it is never sent blank', async () => {
  scenario = 'succeeded'
  seenUrls = []
  const run = await runSkill(['status'], { AGENTOO_SESSION_ID: '' })
  expect(run.code).toBe(0)
  for (const u of seenUrls) expect(u).not.toContain('sessionId')
})

test('with AGENTOO_SESSION_ID set, the mutation and state calls carry it', async () => {
  scenario = 'succeeded'
  seenUrls = []
  const run = await runSkill(['up'], { AGENTOO_SESSION_ID: SESSION_ID })
  expect(run.code).toBe(0)
  expect(seenUrls).toContain(`/api/projects/${PROJECT_ID}/docker/up?sessionId=${SESSION_ID}`)
  expect(seenUrls).toContain(`/api/projects/${PROJECT_ID}/docker?sessionId=${SESSION_ID}`)
})

// --- base URL handling ---------------------------------------------------

test('a trailing slash on AGENTOO_API_BASE does not produce a double slash', async () => {
  scenario = 'succeeded'
  seenUrls = []
  const run = await runSkill(['status'], { AGENTOO_API_BASE: `${base}///` })
  expect(run.code).toBe(0)
  expect(seenUrls).toContain(`/api/projects/${PROJECT_ID}/docker`)
})

// --- readEnv / argv failures ---------------------------------------------

test('a missing AGENTOO_API_BASE fails with one clear line and exit 1', async () => {
  const run = await runSkill(['status'], { AGENTOO_API_BASE: undefined })
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('AGENTOO_API_BASE is not set')
})

test('a missing AGENTOO_PROJECT_ID fails with one clear line and exit 1', async () => {
  const run = await runSkill(['status'], { AGENTOO_PROJECT_ID: undefined })
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('AGENTOO_PROJECT_ID is not set')
})

test('an unknown command exits 1 with the usage line', async () => {
  const run = await runSkill(['frobnicate'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('unknown command "frobnicate"')
})

test('no command at all exits 1 with the usage line', async () => {
  const run = await runSkill([])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('usage: docker.ts')
})

test('an unknown flag is rejected rather than silently dropped', async () => {
  const run = await runSkill(['status', '--follow'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('unknown flag --follow')
})

test('a non-numeric --host-port is rejected before anything is queued', async () => {
  const run = await runSkill(['up', '--host-port', 'banana'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('--host-port must be an integer between 1 and 65535')
})

test('an unreachable API base fails with one line, not an unhandled rejection', async () => {
  // Port 1 on loopback: nothing listens, and the connection is refused fast.
  const run = await runSkill(['status'], { AGENTOO_API_BASE: 'http://127.0.0.1:1/api' })
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('docker skill:')
  expect(run.stderr).toContain('could not reach')
})

// --- the zero-imports rule, and running from anywhere --------------------

test('docker.ts contains no import/require at all — it runs with no node_modules', async () => {
  const source = await Bun.file(SKILL).text()
  const offenders = source
    .split('\n')
    .filter((line) => /^\s*(import\s|export\s+.*\sfrom\s|const\s.*=\s*require\()/.test(line))
  expect(offenders).toEqual([])
})

test('it runs from an arbitrary directory with no package.json or node_modules above it', async () => {
  scenario = 'succeeded'
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-docker-skill-cwd-'))
  seenUrls = []
  const run = await runSkill(['status'], {}, dir)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('daemon: cliInstalled=true available=true version=27.0.0')
  expect(run.stdout).toContain('service web: running')
})


// --- adversarial SSE: everything the happy path never exercises ------------

test('a frame split across chunk boundaries is still parsed (TCP does not respect frames)', async () => {
  resetServer()
  scenario = 'succeeded'
  const whole =
    PRIMING +
    OPERATION_FRAME +
    outputFrame(0, 'stdout', 'halved-frame-marker') +
    frame('end', { operationId: 'op-1', status: 'succeeded', exitCode: 0 })
  // One byte at a time: the pathological case for any buffered frame reader.
  rawStream = whole.split('')
  const run = await runSkill(['stop'])
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('halved-frame-marker')
})

test('a data payload containing escaped newlines does not split the frame', async () => {
  resetServer()
  rawStream = [
    PRIMING,
    outputFrame(0, 'stdout', 'line one\nline two\n\nline three'),
    frame('end', { operationId: 'op-1', status: 'succeeded', exitCode: 0 }),
  ]
  const run = await runSkill(['stop'])
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('line one')
  expect(run.stdout).toContain('line three')
  expect(run.stderr).toBe('')
})

test('malformed JSON in an end frame is reported, exit 1, not a crash', async () => {
  resetServer()
  rawStream = [PRIMING, 'event: end\ndata: {not json\n\n']
  const run = await runSkill(['stop'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('operation event stream sent malformed end data: {not json')
  // Same propagation rule as the unexpected-status case above: handleFrame's
  // own SkillError reaches the top level unwrapped.
  expect(run.stderr).not.toContain('broke:')
})

test('an end frame with a status outside succeeded/failed is reported, exit 1', async () => {
  resetServer()
  rawStream = [
    PRIMING,
    frame('end', { operationId: 'op-1', status: 'cancelled', exitCode: null }),
  ]
  const run = await runSkill(['stop'])
  expect(run.code).toBe(1)
  // Names the status that actually arrived. `describe()` would have rendered
  // this as the useless "unexpected status: string" — `describeValue()` is
  // the distinction, and this assertion is what holds it in place.
  expect(run.stderr).toContain('operation ended with an unexpected status: cancelled')
  // And it is NOT re-wrapped: a SkillError raised inside handleFrame now
  // propagates out of streamOperation instead of being caught and re-thrown
  // as "... broke: <original message>", which buried the real reason one
  // clause deep.
  expect(run.stderr).not.toContain('broke:')
  expect(run.stderr.trim().split('\n')).toHaveLength(1)
})

test('an unexpected status is bounded in length — a corrupt stream cannot flood the transcript', async () => {
  resetServer()
  rawStream = [
    PRIMING,
    frame('end', { operationId: 'op-1', status: 'x'.repeat(400), exitCode: null }),
  ]
  const run = await runSkill(['stop'])
  expect(run.code).toBe(1)
  const line = run.stderr.trim()
  // describeValue's 200-char cap, plus the ellipsis that marks the cut.
  expect(line).toContain('unexpected status: ')
  expect(line.endsWith('…')).toBe(true)
  const rendered = line.slice(line.indexOf('unexpected status: ') + 'unexpected status: '.length)
  expect(rendered).toBe(`${'x'.repeat(200)}…`)
  expect(run.stderr).not.toContain('x'.repeat(201))
})

test('a stream of only comment frames (retry/ping) ends as no-terminal-status, exit 1', async () => {
  resetServer()
  rawStream = [PRIMING, PING, PING]
  const run = await runSkill(['stop'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('ended before the operation reached a terminal status')
})

test('an events route that 404s after the POST succeeded is reported, exit 1', async () => {
  resetServer()
  eventsStatus = 404
  const run = await runSkill(['stop'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('responded 404')
})

test('a POST rejected with the API error envelope surfaces that message, exit 1', async () => {
  resetServer()
  postFailure = { status: 409, body: { error: 'A docker operation is already running' } }
  const run = await runSkill(['up'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('409')
  expect(run.stderr).toContain('A docker operation is already running')
})

test('a POST that answers HTML instead of JSON is reported as such, exit 1', async () => {
  resetServer()
  // What an nginx 502 actually looks like: not the API's error envelope.
  rawPostResponse = {
    status: 502,
    body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
    contentType: 'text/html',
  }
  const run = await runSkill(['up'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('returned a non-JSON body (status 502)')
})

test('an operation frame with no end frame after it does not report success', async () => {
  resetServer()
  rawStream = [
    PRIMING,
    frame('operation', { id: 'op-1', status: 'succeeded', exitCode: 0, error: null }),
  ]
  const run = await runSkill(['stop'])
  // A terminal `status` on an `operation` frame is not an `end` frame.
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('ended before the operation reached a terminal status')
})

test('a CRLF-framed stream is parsed — a proxy may rewrite the route\'s bare LF', async () => {
  resetServer()
  rawStream = [
    'retry: 3000\r\n: connected\r\n\r\n',
    'event: output\r\ndata: {"kind":"output","seq":0,"stream":"stdout","text":"crlf-marker","at":"x"}\r\n\r\n',
    'event: end\r\ndata: {"operationId":"op-1","status":"succeeded","exitCode":0}\r\n\r\n',
  ]
  const run = await runSkill(['stop'])
  // findFrameBoundary recognises '\r\n\r\n' as well as '\n\n'. Before that,
  // indexOf('\n\n') never matched a CRLF stream, nothing was ever parsed, and
  // the read fell out of the loop reporting "ended before ... terminal status"
  // — a silent no-op dressed as a transport failure.
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('crlf-marker')
})

test('a stream mixing LF and CRLF frames splits on whichever separator comes first', async () => {
  resetServer()
  // The branch findFrameBoundary exists for: both separators present in one
  // buffer, so "earliest wins" is the only rule that keeps frames aligned.
  // A CRLF frame *contains* a '\n\n'-free region but the '\r\n\r\n' sits
  // earlier than the next LF boundary, so a naive indexOf('\n\n') would slice
  // straight through it.
  rawStream = [
    PRIMING,
    'event: output\r\ndata: {"kind":"output","seq":0,"stream":"stdout","text":"first-crlf"}\r\n\r\n',
    outputFrame(1, 'stdout', 'then-lf'),
    'event: end\r\ndata: {"operationId":"op-1","status":"succeeded","exitCode":0}\r\n\r\n',
  ]
  const run = await runSkill(['stop'])
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('first-crlf')
  expect(run.stdout).toContain('then-lf')
  // Order preserved: neither frame swallowed the other.
  expect(run.stdout.indexOf('first-crlf')).toBeLessThan(run.stdout.indexOf('then-lf'))
})

// --- the request bodies, against the route's own validators ---------------

test('every mutation body docker.ts builds is accepted by the real request schema', async () => {
  resetServer()
  scenario = 'succeeded'
  await runSkill(['up', '--build', '--force-recreate', '--remove-orphans', 'web', 'db'])
  await runSkill(['stop', 'web'])
  await runSkill(['restart'])
  await runSkill(['down', '--remove-volumes', '--remove-images'])

  expect(postedBodies.map((b) => b.kind)).toEqual(['up', 'stop', 'restart', 'down'])
  for (const posted of postedBodies) {
    if (!posted.valid) {
      throw new Error(`${posted.kind} body rejected by its own schema: ${posted.issues}`)
    }
  }
  expect(postedBodies[0]?.body).toEqual({
    services: ['web', 'db'],
    build: true,
    forceRecreate: true,
    removeOrphans: true,
  })
  expect(postedBodies[1]?.body).toEqual({ services: ['web'] })
  expect(postedBodies[2]?.body).toEqual({})
  expect(postedBodies[3]?.body).toEqual({ removeVolumes: true, removeImages: true })
})

test('--container-port/--host-port are sent as numbers, not strings', async () => {
  resetServer()
  scenario = 'succeeded'
  await runSkill(['up', '--container-port', '3000', '--host-port', '20030'])
  expect(postedBodies[0]?.body).toEqual({ containerPort: 3000, hostPort: 20030 })
  expect(postedBodies[0]?.valid).toBe(true)
})

test('--host-port below 1024 is refused locally, with the API\'s real rule', async () => {
  // upRequestSchema.hostPort is `.min(1024)`
  // (backend/src/features/docker/schema.ts). The skill now enforces the same
  // floor instead of shipping the request and letting the agent decode a 400,
  // and its message states the actual rule rather than the old, wrong
  // "between 1 and 65535".
  resetServer()
  scenario = 'succeeded'
  const run = await runSkill(['up', '--host-port', '80'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain(
    '--host-port must be 1024 or higher (ports below 1024 are privileged), got 80',
  )
  // Refused before anything left the process: no operation was ever queued.
  expect(postedBodies).toEqual([])
  expect(seenUrls).toEqual([])
})

test('--host-port boundary: 1023 refused, 1024 accepted and sent', async () => {
  resetServer()
  scenario = 'succeeded'
  const low = await runSkill(['up', '--host-port', '1023'])
  expect(low.code).toBe(1)
  expect(low.stderr).toContain('must be 1024 or higher')
  expect(postedBodies).toEqual([])

  resetServer()
  const ok = await runSkill(['up', '--host-port', '1024'])
  expect(ok.code).toBe(0)
  expect(postedBodies[0]?.body).toEqual({ hostPort: 1024 })
  // The floor the skill enforces is the floor the route enforces — same value,
  // checked by the route's own schema.
  expect(postedBodies[0]?.valid).toBe(true)
})

test('--container-port keeps its floor of 1 — the API sets no 1024 floor there', async () => {
  // The fix must not raise the floor for both flags: upRequestSchema's
  // containerPort is `.min(1)`, because it names a port *inside* the
  // container, where privileged ports are ordinary.
  resetServer()
  scenario = 'succeeded'
  const run = await runSkill(['up', '--container-port', '80'])
  expect(run.code).toBe(0)
  expect(postedBodies[0]?.body).toEqual({ containerPort: 80 })
  expect(postedBodies[0]?.valid).toBe(true)
})

test('a non-numeric --host-port still gets the plain range message, not the floor one', async () => {
  // The two checks stay distinct: "not a number" and "below the floor" are
  // different mistakes and get different messages, the same way the API's own
  // schema distinguishes them.
  resetServer()
  const run = await runSkill(['up', '--host-port', 'banana'])
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('--host-port must be an integer between 1 and 65535')
  expect(run.stderr).not.toContain('1024 or higher')
})

test('a malformed AGENTOO_API_BASE fails with one clear line rather than crashing', async () => {
  // apiBaseUrl now brackets IPv6 literals (backend/src/env.ts), so a session
  // is no longer handed `http://::1:8000/api`. This keeps the skill's own
  // behaviour pinned for any *other* way a bad base could reach it: one
  // "could not reach"/"docker skill:" line and exit 1, never an unhandled
  // rejection or a stack trace.
  const run = await runSkill(['status'], { AGENTOO_API_BASE: 'http://::1:8000/api' })
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('docker skill:')
  expect(run.stderr.trim().split('\n')).toHaveLength(1)
})

test('the bracketed IPv6 base apiBaseUrl now produces is one docker.ts can dial', async () => {
  // The positive half: the shape env.ts emits for an IPv6 bind parses and is
  // reached. Nothing listens on [::1]:9 here, so this asserts the URL was
  // constructed and dialled — a parse failure would read differently.
  const run = await runSkill(['status'], { AGENTOO_API_BASE: 'http://[::1]:9/api' })
  expect(run.code).toBe(1)
  expect(run.stderr).toContain('could not reach http://[::1]:9/api/projects/')
})
