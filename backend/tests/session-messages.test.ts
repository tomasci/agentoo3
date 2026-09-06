// Backward pagination for GET /sessions/{id}/messages.
//
// listMessagePage runs real `and`/`eq`/`gt`/`lt`/`desc` conditions from
// drizzle-orm against a fake `db`, so these tests exercise the actual
// query-building code, not a re-implementation of it. What is faked is only
// the bottom of the stack: `messages`/`sessions` rows are held in memory and
// the fake db's `where`/`orderBy`/`limit` walk the real drizzle condition
// objects (their `queryChunks`) to filter/sort/truncate them, the same way
// session-export.test.ts fakes `db.select()` for a simpler query shape. No
// Postgres involved, matching how the rest of this suite avoids one.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

// --- fixtures -----------------------------------------------------------------

const SESSION_ID = '7c9b7a0e-1a2b-4c3d-9e4f-5a6b7c8d9e0f'
const TRANSCRIPT_LEN = 10

type Row = Record<string, unknown>

const sessionRowFor = (id: string): Row => ({ id })

const message = (seq: number): Row => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  sessionId: SESSION_ID,
  seq,
  type: 'assistant',
  parentToolUseId: null,
  title: null,
  pending: false,
  payload: { n: seq },
  createdAt: new Date(`2026-09-01T10:${String(seq).padStart(2, '0')}:00.000Z`),
})

// seq 0..9, already in order: the ordering under test is applied by the fake
// db (see below), not by how the fixture happens to be laid out.
const fullTranscript = (): Row[] => Array.from({ length: TRANSCRIPT_LEN }, (_, seq) => message(seq))

let sessionRow: Row | undefined
let transcript: Row[]
// Empty by default: every test below exercises pagination, not the `files`
// field service.ts now attaches — see session-message-files.test.ts for that.
let messageFileLinks: Row[] = []
let sessionFileRows: Row[] = []

beforeEach(() => {
  sessionRow = sessionRowFor(SESSION_ID)
  transcript = fullTranscript()
  messageFileLinks = []
  sessionFileRows = []
})

// --- a fake db that actually filters, sorts and truncates ---------------------
//
// Walking real drizzle SQL nodes rather than special-casing per test: a column
// object carries `.name` (and `.columnType`), a `StringChunk` carries `.value`
// as a string array, and a bound param is wrapped as `{ value, encoder }`.
// `and(eq(...), gt(...))` nests one more SQL layer than a single condition —
// see the node inspection this was built against — so the walk recurses
// instead of assuming a fixed depth.

function isStringChunk(x: unknown): x is { value: unknown[] } {
  return !!x && typeof x === 'object' && Array.isArray((x as { value?: unknown }).value)
}
function isColumn(x: unknown): x is { name: string } {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { name?: unknown }).name === 'string' &&
    typeof (x as { columnType?: unknown }).columnType === 'string'
  )
}
function isParam(x: unknown): x is { value: unknown } {
  return !!x && typeof x === 'object' && 'value' in x && !Array.isArray((x as { value: unknown }).value)
}
function isSqlNode(x: unknown): x is { queryChunks: unknown[] } {
  return !!x && typeof x === 'object' && Array.isArray((x as { queryChunks?: unknown }).queryChunks)
}
function textOf(node: { queryChunks: unknown[] }): string {
  return node.queryChunks
    .filter(isStringChunk)
    .map((c) => c.value.join(''))
    .join('')
}

/** Every bound value under an `inArray(...)` node — its params sit in a
 * nested array chunk rather than alongside the column, so a plain `find`
 * (which collectLeaves below uses for a single-value condition) misses them. */
function inArrayValues(node: unknown): unknown[] {
  if (!isSqlNode(node)) return []
  return node.queryChunks
    .flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]))
    .filter(isParam)
    .map((p) => p.value)
}

type Leaf = { col: string; op: '=' | '>' | '<'; value: unknown }

/** Every `col op value` leaf reachable under a where/order argument. */
function collectLeaves(node: unknown, out: Leaf[] = []): Leaf[] {
  if (!isSqlNode(node)) return out
  const col = node.queryChunks.find(isColumn)
  const opMatch = textOf(node).match(/ (=|>|<) /)
  if (col && opMatch) {
    const param = node.queryChunks.find(isParam)
    out.push({ col: col.name, op: opMatch[1] as Leaf['op'], value: param?.value })
    return out
  }
  for (const chunk of node.queryChunks) collectLeaves(chunk, out)
  return out
}

function isDescOrder(node: unknown): boolean {
  return isSqlNode(node) && /desc/.test(textOf(node))
}

function rowsFor(table: string, whereNode: unknown, orderArg: unknown, limitN: number | null): Row[] {
  if (table === 'sessions') return sessionRow ? [sessionRow] : []
  // service.ts's filesForMessages() — a message's attachments, resolved off
  // message_files joined (in application code, not SQL) to session_files.
  if (table === 'message_files') {
    const ids = inArrayValues(whereNode)
    return messageFileLinks.filter((r) => ids.includes(r.messageId))
  }
  if (table === 'session_files') {
    const ids = inArrayValues(whereNode)
    return sessionFileRows.filter((r) => ids.includes(r.id))
  }
  if (table !== 'messages') throw new Error(`fake db: unexpected table ${table}`)

  const cursor = collectLeaves(whereNode).find((l) => l.col === 'seq')
  let rows = transcript.filter((r) => {
    if (!cursor) return true
    const seq = r.seq as number
    return cursor.op === '>' ? seq > (cursor.value as number) : seq < (cursor.value as number)
  })

  const desc = isDescOrder(orderArg)
  rows = [...rows].sort((a, b) =>
    desc ? (b.seq as number) - (a.seq as number) : (a.seq as number) - (b.seq as number),
  )

  return limitN === null ? rows : rows.slice(0, limitN)
}

function select() {
  let table = ''
  let whereNode: unknown = null
  let orderArg: unknown = null
  let limitN: number | null = null
  const builder = {
    from(t: unknown) {
      table = getTableName(t as Parameters<typeof getTableName>[0])
      return builder
    },
    where(node: unknown) {
      whereNode = node
      return builder
    },
    orderBy(...cols: unknown[]) {
      orderArg = cols[0]
      return builder
    },
    limit(n: number) {
      limitN = n
      return builder
    },
    then: (ok?: (rows: Row[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(table, whereNode, orderArg, limitN)).then(ok, err),
  }
  return builder
}

mock.module(`${B}/db/client.ts`, () => ({
  db: { select },
  closeDb: async () => {},
}))

// service.ts imports these at module scope; stubbed so the import does not
// try to reach a real Redis, same reasoning as session-export.test.ts.
// Mocked with the full shape `@/queue/index.ts` actually exports (including
// the attachments-gc queue), not just what this file's own code path needs —
// an incomplete mock here poisons the shared module registry for *any* other
// file whose import chain reaches the real module while this one is loaded
// (see session-recovery.test.ts's identical mock for the same reason).
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

const { listMessagePage } = await import(`${B}/features/sessions/service.ts`)

const seqs = (page: { messages: { seq: number }[] }) => page.messages.map((m) => m.seq)

// --- before: the backward page -------------------------------------------------

test('a backward page returns the newest `limit` messages, ascending', async () => {
  const page = await listMessagePage(SESSION_ID, { before: 10, limit: 4 })
  expect(seqs(page)).toEqual([6, 7, 8, 9])
})

test('hasOlder is true when older messages exist below the page', async () => {
  const page = await listMessagePage(SESSION_ID, { before: 10, limit: 4 })
  expect(page.hasOlder).toBe(true)
})

test('hasOlder is false once the page reaches the start of the transcript', async () => {
  // seq 0..3 is the whole prefix below before=4: nothing older remains.
  const page = await listMessagePage(SESSION_ID, { before: 4, limit: 4 })
  expect(seqs(page)).toEqual([0, 1, 2, 3])
  expect(page.hasOlder).toBe(false)
})

test('hasOlder reflects a page that only partially drains what is left', async () => {
  // seq < 5 is [0,1,2,3,4]; a page of 3 leaves seq 0 and 1 undelivered.
  const page = await listMessagePage(SESSION_ID, { before: 5, limit: 3 })
  expect(seqs(page)).toEqual([2, 3, 4])
  expect(page.hasOlder).toBe(true)
})

test('an empty page (nothing older than before) reports hasOlder=false', async () => {
  const page = await listMessagePage(SESSION_ID, { before: 0 })
  expect(page.messages).toEqual([])
  expect(page.hasOlder).toBe(false)
})

test('`limit` defaults to 100 when `before` is given without one', async () => {
  // Only 10 messages exist, so the default page absorbs the whole transcript
  // in one backward call and correctly reports nothing older is left.
  const page = await listMessagePage(SESSION_ID, { before: 10 })
  expect(seqs(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(page.hasOlder).toBe(false)
})

// --- limit alone: the initial-load page, no cursor needed ---------------------

test('`limit` alone returns the newest `limit` messages, ascending', async () => {
  const page = await listMessagePage(SESSION_ID, { limit: 4 })
  expect(seqs(page)).toEqual([6, 7, 8, 9])
})

test('`limit` alone reports hasOlder=true when the transcript is longer than the page', async () => {
  const page = await listMessagePage(SESSION_ID, { limit: 4 })
  expect(page.hasOlder).toBe(true)
})

test('`limit` alone reports hasOlder=false when the whole transcript fits in one page', async () => {
  // 10 messages exist; asking for up to 20 gets all of them with nothing left.
  const page = await listMessagePage(SESSION_ID, { limit: 20 })
  expect(seqs(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(page.hasOlder).toBe(false)
})

// --- after: unchanged, forward, unbounded --------------------------------------

test('after mode returns everything after a seq, ascending and unbounded', async () => {
  const page = await listMessagePage(SESSION_ID, { after: 4 })
  expect(seqs(page)).toEqual([5, 6, 7, 8, 9])
  expect(page.hasOlder).toBe(false)
})

test('no cursors at all returns the whole transcript, exactly as before pagination', async () => {
  const page = await listMessagePage(SESSION_ID, {})
  expect(seqs(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(page.hasOlder).toBe(false)
})

test('`limit` has no effect in after mode: unbounded means unbounded', async () => {
  const page = await listMessagePage(SESSION_ID, { after: 4, limit: 2 })
  expect(seqs(page)).toEqual([5, 6, 7, 8, 9])
})

// --- the conflict between the two cursors --------------------------------------

test('after and before together is refused as a 400, not a guess', async () => {
  const error = await listMessagePage(SESSION_ID, { after: 3, before: 7 }).catch((e: unknown) => e)
  expect((error as Error).message).toMatch(/after and before/)
  expect((error as { status: number }).status).toBe(400)
})

// --- existence ------------------------------------------------------------------

test('an unknown session id is a 404, not an empty page', async () => {
  sessionRow = undefined
  const error = await listMessagePage('99999999-9999-4999-8999-999999999999', {}).catch(
    (e: unknown) => e,
  )
  expect((error as Error).message).toBe('Session not found')
  expect((error as { status: number }).status).toBe(404)
})

// --- Gap A: each message's `files`, resolved from message_files ---------------
//
// Everything above is pagination; this is the join service.ts now does on
// top of it. message_files/session_files use the same node-walking fake as
// `sessions`/`messages` above (see inArrayValues), so `inArray(...)` is
// exercised for real rather than assumed.

test('a message with no attachments carries an empty files array, not undefined', async () => {
  const page = await listMessagePage(SESSION_ID, { limit: 1 })
  expect(page.messages[0]?.files).toEqual([])
})

test('a message that announced a live file resolves it off session_files', async () => {
  const id = message(9).id
  messageFileLinks = [{ messageId: id, fileId: 'f1', originalFilename: 'error.log' }]
  sessionFileRows = [
    {
      id: 'f1',
      originalFilename: 'error.log',
      mimeType: 'text/plain',
      sizeBytes: 2048,
      status: 'ready',
    },
  ]

  const page = await listMessagePage(SESSION_ID, { limit: 1 })
  expect(page.messages[0]?.files).toEqual([
    { id: 'f1', originalFilename: 'error.log', mimeType: 'text/plain', sizeBytes: 2048, status: 'ready' },
  ])
})

test('files for one message never leak onto another', async () => {
  messageFileLinks = [{ messageId: message(9).id, fileId: 'f1', originalFilename: 'only-on-9.log' }]
  sessionFileRows = [
    { id: 'f1', originalFilename: 'only-on-9.log', mimeType: 'text/plain', sizeBytes: 1, status: 'ready' },
  ]

  const page = await listMessagePage(SESSION_ID, { limit: 2 })
  const [eight, nine] = page.messages
  expect(eight?.seq).toBe(8)
  expect(eight?.files).toEqual([])
  expect(nine?.seq).toBe(9)
  expect(nine?.files).toHaveLength(1)
})

// --- the removed-file placeholder (acceptance criterion 11) -------------------

test('a hard-deleted file renders a placeholder instead of vanishing from the message', async () => {
  // fileId null: ON DELETE SET NULL cleared it when session_files was hard
  // deleted (gc.ts's cleanup / reconcile.ts's remediateAnomaly), but the link
  // row survives and still carries the denormalised name.
  messageFileLinks = [{ messageId: message(9).id, fileId: null, originalFilename: 'attached.log' }]
  sessionFileRows = []

  const page = await listMessagePage(SESSION_ID, { limit: 1 })
  expect(page.messages[0]?.files).toEqual([
    { id: null, originalFilename: 'attached.log', mimeType: null, sizeBytes: null, status: null },
  ])
})

test('a link written before originalFilename existed still renders a placeholder, unnamed', async () => {
  messageFileLinks = [{ messageId: message(9).id, fileId: null, originalFilename: null }]
  sessionFileRows = []

  const page = await listMessagePage(SESSION_ID, { limit: 1 })
  expect(page.messages[0]?.files).toEqual([
    { id: null, originalFilename: null, mimeType: null, sizeBytes: null, status: null },
  ])
})

// --- the route: query params reach listMessagePage, and zod guards `limit` ----
//
// A separate server, like session-stream.test.ts's, with the service module
// itself mocked: this section is only about HTTP wiring (query parsing, the
// envelope shape, the limit bound), not about the pagination logic above,
// which already runs against the real service.

const pageCalls: { id: string; opts: unknown }[] = []
const FAKE_PAGE = { messages: [{ seq: 9 }], hasOlder: true }

// Forwarded, not hand-rolled, for the same reason as session-stream.test.ts's
// identical-in-spirit registration: mock.module swaps the whole namespace for
// this specifier process-wide, so a hand-picked subset here would silently
// starve any other file whose import of service.ts resolves to this
// registration of whatever export it needed that this list left out — exactly
// what happened once toMessageDto gained a caller outside this file (the
// worker) and this mock had never heard of it.
const realService = await import(`${B}/features/sessions/service.ts`)
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realService,
  listMessagePage: async (id: string, opts: unknown) => {
    pageCalls.push({ id, opts })
    return FAKE_PAGE
  },
  listMessages: async () => [],
  listSessions: async () => [],
  getSession: async () => ({}),
  createSession: async () => ({}),
  updateSession: async () => ({}),
  deleteSession: async () => {},
  sendMessage: async () => ({}),
  interruptSession: async () => ({}),
  exportSession: async () => ({}),
  sessionExportFileName: () => 'agentoo-session-00000000.json',
}))

const { sessionsRouter } = await import(`${B}/features/sessions/routes.ts`)

const server = Bun.serve({ port: 0, idleTimeout: 60, fetch: (req) => sessionsRouter.fetch(req) })
const base = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  pageCalls.length = 0
})

test('the route answers with the envelope, not a bare array', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/messages`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(FAKE_PAGE)
})

test('after, before and limit are coerced to numbers and forwarded as-is', async () => {
  await fetch(`${base}/sessions/${SESSION_ID}/messages?before=42&limit=17`)
  expect(pageCalls).toEqual([{ id: SESSION_ID, opts: { after: undefined, before: 42, limit: 17 } }])
})

test('after and before can both reach the service; only it decides that is a conflict', async () => {
  await fetch(`${base}/sessions/${SESSION_ID}/messages?after=3&before=7`)
  expect(pageCalls).toEqual([{ id: SESSION_ID, opts: { after: 3, before: 7, limit: undefined } }])
})

test('limit=0 is rejected before the service is ever called', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/messages?limit=0`)
  expect(res.status).toBe(400)
  expect(pageCalls).toEqual([])
})

test('limit=501 is rejected before the service is ever called', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/messages?limit=501`)
  expect(res.status).toBe(400)
  expect(pageCalls).toEqual([])
})

test('limit=500 is the accepted boundary', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/messages?before=10&limit=500`)
  expect(res.status).toBe(200)
  expect(pageCalls).toEqual([{ id: SESSION_ID, opts: { after: undefined, before: 10, limit: 500 } }])
})

test('a non-integer limit is rejected', async () => {
  const res = await fetch(`${base}/sessions/${SESSION_ID}/messages?limit=1.5`)
  expect(res.status).toBe(400)
  expect(pageCalls).toEqual([])
})

afterAll(() => server.stop(true))
