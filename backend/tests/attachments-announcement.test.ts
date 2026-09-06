// Per-turn announcement: which files a turn tells the agent about, and when.
//
// This drives the real `runTurn` from session-run.worker.ts — the transaction
// that flips `pending` and stamps `announcedSeq` is the thing under test, so
// re-implementing its query here would prove nothing. The fake db below walks
// the *real* drizzle condition objects (the same trick session-messages.test.ts
// uses) so `isNull(announcedSeq)`, `eq(status, 'ready')` and `isNull(deletedAt)`
// are actually applied rather than assumed.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { sessionMessageSchema } from '../src/features/sessions/schema'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

const SESSION_ID = 'ab12cd34-ef56-7890-abcd-ef1234567890'
const PROJECT_ID = '11111111-2222-3333-4444-555555555555'

let files: Row[] = []
// Every event runTurn published this test, kept even while `quiet` keeps it off
// the real bus, so a test can assert on what would have gone out without
// touching Redis.
let publishedEvents: { kind: string; message?: unknown }[] = []
let pending: Row[] = []
let messageFileLinks: { messageId: string; fileId: string; originalFilename: string | null }[] = []
let prompts: string[] = []
let queryBehaviour: () => AsyncIterable<unknown> = () => empty()

async function* empty(): AsyncIterable<unknown> {}

async function* throwing(message: string): AsyncIterable<unknown> {
  await Promise.resolve()
  throw new Error(message)
  // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
  yield undefined
}

const file = (over: Partial<Row> & { id: string; createdAt: Date }): Row => ({
  sessionId: SESSION_ID,
  originalFilename: 'error.log',
  storedName: `${over.id}-${(over.originalFilename as string | undefined) ?? 'error.log'}`,
  mimeType: 'text/plain',
  sizeBytes: 2048,
  checksum: 'a'.repeat(64),
  status: 'ready',
  lineCount: 40,
  pageCount: null,
  announcedSeq: null,
  deletedAt: null,
  ...over,
})

// --- a fake db that evaluates the real WHERE ---------------------------------
//
// A drizzle condition is a tree of SQL nodes: string chunks carry the operator
// text, column chunks carry the *database* column name, and bound values are
// wrapped params. Mapping the column name back to its JS property through the
// table definition is what lets these fixtures stay camelCase while the walk
// reads `announced_seq`.

function isSqlNode(x: unknown): x is { queryChunks: unknown[] } {
  return !!x && typeof x === 'object' && Array.isArray((x as { queryChunks?: unknown }).queryChunks)
}
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
  return (
    !!x &&
    typeof x === 'object' &&
    'value' in x &&
    !Array.isArray((x as { value: unknown }).value) &&
    !isColumn(x)
  )
}
function textOf(node: { queryChunks: unknown[] }): string {
  return node.queryChunks
    .filter(isStringChunk)
    .map((c) => c.value.join(''))
    .join('')
}

/** db column name -> JS property, for one table. */
function propertyMap(table: unknown): Map<string, string> {
  const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0])
  return new Map(Object.entries(columns).map(([prop, col]) => [(col as { name: string }).name, prop]))
}

/** True when `row` satisfies the drizzle condition `node`. */
function matches(node: unknown, row: Row, props: Map<string, string>): boolean {
  if (!isSqlNode(node)) return true
  const text = textOf(node)
  const col = node.queryChunks.find(isColumn)
  if (col) {
    const key = props.get(col.name) ?? col.name
    // `inArray` puts its values in a nested array chunk rather than alongside
    // the column, so the flatten below is what makes ' in ' work at all.
    const params = node.queryChunks
      .flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]))
      .filter(isParam)
      .map((p) => p.value)
    if (/ is null/.test(text)) return row[key] === null || row[key] === undefined
    if (/ is not null/.test(text)) return row[key] !== null && row[key] !== undefined
    if (/ in /.test(text)) return params.includes(row[key])
    if (/ = /.test(text)) return row[key] === params[0]
    throw new Error(`fake db: unsupported operator in "${text}"`)
  }
  return node.queryChunks.every((chunk) => (isSqlNode(chunk) ? matches(chunk, row, props) : true))
}

const table = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0])

const CLAIMED = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  orchestrator: null,
  worktreePath: '/tmp',
  sdkSessionId: null,
  maxBudgetUsd: null,
  totalCostUsd: 0,
  status: 'running',
}

const db = {
  select: (fields?: unknown) => {
    let t = ''
    let whereNode: unknown = null
    const q = {
      from(x: unknown) {
        t = table(x)
        return q
      },
      where(node: unknown) {
        whereNode = node
        return q
      },
      orderBy: () => q,
      limit: async (_n?: number) => rows(),
      then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve().then(rows).then(ok, err),
    }
    const rows = (): Row[] => {
      if (t === 'projects') return [{ id: PROJECT_ID, slug: 'demo', sshKeyId: null }]
      if (t === 'session_files') {
        const props = propertyMap(schema.sessionFiles)
        return files.filter((r) => matches(whereNode, r, props))
      }
      if (t === 'messages') return fields === undefined ? pending : []
      if (t === 'message_files') {
        const props = propertyMap(schema.messageFiles)
        return messageFileLinks.filter((r) => matches(whereNode, r as Row, props))
      }
      return []
    }
    return q
  },
  update: (t: unknown) => {
    const name = table(t)
    let payload: Row = {}
    return {
      set: (p: Row) => {
        payload = p
        const where = (node: unknown) => ({
          returning: async () => (name === 'sessions' ? [CLAIMED] : []),
          then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) => {
            if (name === 'session_files') {
              const props = propertyMap(schema.sessionFiles)
              for (const row of files) {
                if (matches(node, row, props)) Object.assign(row, payload)
              }
            }
            if (name === 'messages') {
              for (const row of pending) Object.assign(row, payload)
            }
            return Promise.resolve([]).then(ok, err)
          },
        })
        return { where }
      },
    }
  },
  insert: (t: unknown) => ({
    values: (value: Row | Row[]) => {
      const rows = Array.isArray(value) ? value : [value]
      if (table(t) === 'message_files') {
        for (const row of rows) {
          messageFileLinks.push({
            messageId: String(row.messageId),
            fileId: String(row.fileId),
            originalFilename: (row.originalFilename as string | null | undefined) ?? null,
          })
        }
      }
      // Real Postgres fills these in on INSERT (defaultRandom/defaultNow); a
      // row this fake merely echoes back is missing them, which toMessageDto
      // (now the one place a published message is built — see service.ts) needs.
      if (table(t) === 'messages') {
        for (const row of rows) {
          row.id ??= crypto.randomUUID()
          row.createdAt ??= new Date()
        }
      }
      return {
        returning: async () => rows,
        then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(ok, err),
      }
    },
  }),
  // Only ever called on message_files, by unstampAnnouncement()'s un-stamp —
  // nothing else in this file's code path deletes anything.
  delete: (t: unknown) => ({
    where: (node: unknown) => ({
      then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) => {
        if (table(t) === 'message_files') {
          const props = propertyMap(schema.messageFiles)
          messageFileLinks = messageFileLinks.filter((link) => !matches(node, link as Row, props))
        }
        return Promise.resolve([]).then(ok, err)
      },
    }),
  }),
  transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
}

const schema = await import(`${B}/db/schema.ts`)

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

// Forwarded, not replaced, and only silenced while this file runs — the same
// reason session-recovery.test.ts does it this way: a stub namespace would
// otherwise reach session-stream.test.ts, which needs the real bus.
let quiet = true
// Captured rather than fired immediately, same as session-recovery.test.ts's
// `interrupters` — a test that wants to interrupt a turn in flight calls one
// of these from inside its fake `query()` generator, after the turn has
// already registered it.
let interrupters: ((event: { kind: 'interrupt' }) => void)[] = []
const realEvents = await import(`${B}/lib/events.ts`)
const realPublish = realEvents.publishSessionEvent
const realSubscribeControl = realEvents.subscribeControl
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async (event: unknown) => {
    publishedEvents.push(event as { kind: string; message?: unknown })
    if (!quiet) await realPublish(event as never)
  },
  subscribeControl: (sessionId: string, onEvent: (event: never) => void) => {
    if (!quiet) return realSubscribeControl(sessionId, onEvent)
    interrupters.push(onEvent as (event: { kind: 'interrupt' }) => void)
    return () => {}
  },
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

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    return queryBehaviour()
  },
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
}))

const realRunnerOptions = await import(`${B}/features/sessions/runner-options.ts`)
const realOptionsFor = realRunnerOptions.optionsFor
mock.module(`${B}/features/sessions/runner-options.ts`, () => ({
  ...realRunnerOptions,
  optionsFor: async (...args: Parameters<typeof realOptionsFor>) =>
    quiet ? { cwd: '/tmp' } : realOptionsFor(...args),
}))

afterAll(() => {
  quiet = false
})

const { runTurn } = await import(`${B}/queue/session-run.worker.ts`)

/** One turn: queue a prompt at `seq`, run it, return the prompt the SDK saw. */
async function turn(seq: number, text = 'do the thing'): Promise<string> {
  pending = [
    {
      id: `msg-${seq}`,
      sessionId: SESSION_ID,
      seq,
      type: 'prompt',
      parentToolUseId: null,
      title: null,
      payload: { text },
      pending: true,
      createdAt: new Date('2026-09-01T12:00:00Z'),
    },
  ]
  const before = prompts.length
  await runTurn({ sessionId: SESSION_ID })
  return prompts[before] ?? ''
}

const UPLOADS = `${process.env.ATTACHMENTS_DIR}/sessions/ab/12/${SESSION_ID}/uploads`

beforeEach(() => {
  files = []
  pending = []
  messageFileLinks = []
  prompts = []
  interrupters = []
  publishedEvents = []
  queryBehaviour = () => empty()
})

// --- a file attached before the first turn ------------------------------------

test('a file attached before a turn is announced on that turn, with its uploads dir', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]

  const prompt = await turn(4)

  expect(prompt).toContain('[attachments added] 1 file is now available')
  expect(prompt).toContain(UPLOADS)
  expect(prompt).toContain(`- ${UPLOADS}/f1-error.log — error.log, text/plain, 40 lines, 2.0 KB`)
  expect(prompt.endsWith('do the thing')).toBe(true)
})

test('the announcement tells the agent how to read a large file without slurping it', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z'), lineCount: 480_000 })]

  const prompt = await turn(4)

  expect(prompt).toContain('use Grep, or Read with offset/limit')
  expect(prompt).toContain('ATTACHMENTS.md')
})

test('announcing stamps announcedSeq with the prompt seq and links the message', async () => {
  files = [
    file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') }),
    file({ id: 'f2', createdAt: new Date('2026-09-01T10:01:00Z') }),
  ]

  await turn(7)

  expect(files.map((f) => f.announcedSeq)).toEqual([7, 7])
  expect(messageFileLinks).toEqual([
    { messageId: 'msg-7', fileId: 'f1', originalFilename: 'error.log' },
    { messageId: 'msg-7', fileId: 'f2', originalFilename: 'error.log' },
  ])
})

// --- exactly once -------------------------------------------------------------

test('the same file is not announced again on the next turn', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]

  const first = await turn(4)
  const second = await turn(5, 'and again')

  expect(first).toContain('[attachments added]')
  expect(second).toBe('and again')
  expect(messageFileLinks).toHaveLength(1)
})

test('a file attached mid-session is announced on the very next turn, alone', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  await turn(4)

  // The upload lands between turns — no restart, no new session.
  files.push(file({ id: 'f2', originalFilename: 'spec.pdf', createdAt: new Date('2026-09-01T11:00:00Z'), mimeType: 'application/pdf', lineCount: null, pageCount: 14 }))

  const second = await turn(5, 'now look at the spec')

  expect(second).toContain('[attachments added] 1 file is now available')
  expect(second).toContain(`- ${UPLOADS}/f2-spec.pdf — spec.pdf, application/pdf, 14 pages, 2.0 KB`)
  expect(second).not.toContain('error.log')
  expect(files.map((f) => f.announcedSeq)).toEqual([4, 5])
})

test('a turn with nothing new to say prepends nothing at all', async () => {
  const prompt = await turn(4, 'just talking')
  expect(prompt).toBe('just talking')
  expect(messageFileLinks).toEqual([])
})

// --- republishing the prompt once its files are linked ------------------------
//
// sendMessage (service.ts) publishes the prompt at send time, before this
// transaction has run — so the browser's own copy is stuck at `files: []`
// until something republishes it. runTurn does that itself, right after the
// transaction above commits, using messageDto() (service.ts) to fetch exactly
// the shape listMessages/listMessagePage already return for the same row.
//
// This is the third of the three SSE "message" publish sites (the other two,
// sendMessage and appendMessage, are pinned against the same schema in
// session-message-shape.test.ts) — driven here rather than there because it
// only exists inside runTurn's announcement transaction, which needs this
// file's heavier fixture (session_files, the SDK query mock) to reach at all.
// session-message-shape.test.ts's own header explains why it does not import
// service.ts's `messageDto` directly to shortcut that: this module is also
// mocked, process-wide, by session-messages.test.ts and session-stream.test.ts,
// so a direct call from a file that does not itself register that mock could
// silently resolve to whichever of those happened to still be active.

test('a turn that links files republishes the prompt with files populated', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]

  await turn(7)

  const republished = publishedEvents.filter((e) => e.kind === 'message')
  expect(republished).toHaveLength(1)
  const message = republished[0]?.message as {
    seq: number
    pending: boolean
    files: unknown[]
  }
  expect(message.seq).toBe(7)
  // Flipped by the same transaction that linked the files, which is exactly
  // what lets the frontend's seq-keyed merge (message-cache.ts's
  // `sameMessage`) treat this as a real update rather than a no-op: `pending`
  // is part of its equality check and always goes true -> false here.
  expect(message.pending).toBe(false)
  expect(message.files).toEqual([
    {
      id: 'f1',
      originalFilename: 'error.log',
      mimeType: 'text/plain',
      sizeBytes: 2048,
      status: 'ready',
    },
  ])
})

test('the republished message satisfies the same contract, same key set', async () => {
  // Key-set check, same convention as session-message-shape.test.ts's own two
  // (against `sessionMessageSchema.shape` rather than a second call into
  // service.ts — see this file's header comment on why): this is the
  // historical bug restated for the third publish site, a raw row published
  // instead of messageDto()'s DTO. Not the fuller `.safeParse` those two also
  // do: this file's ids ('f1', 'msg-7') are deliberately readable rather than
  // real UUIDs, which `sessionMessageSchema`'s `.uuid()` fields would reject
  // for a reason unrelated to what this test is pinning.
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]

  await turn(7)

  const republished = publishedEvents.filter((e) => e.kind === 'message')
  expect(republished).toHaveLength(1)
  expect(Object.keys(republished[0]?.message as object).sort()).toEqual(
    Object.keys(sessionMessageSchema.shape).sort(),
  )
})

test('a turn that links nothing new publishes no extra message event', async () => {
  await turn(4, 'just talking')

  expect(publishedEvents.filter((e) => e.kind === 'message')).toEqual([])
})

// --- what must never be announced ---------------------------------------------

test('a soft-deleted file is never announced', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z'), deletedAt: new Date() })]
  expect(await turn(4, 'hello')).toBe('hello')
  expect(files[0]?.announcedSeq).toBeNull()
})

test('a file whose blob has gone missing is never announced', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z'), status: 'missing' })]
  expect(await turn(4, 'hello')).toBe('hello')
  expect(files[0]?.announcedSeq).toBeNull()
})

test('a file that belongs to another session is never announced', async () => {
  files = [
    file({
      id: 'f1',
      sessionId: '99999999-9999-4999-8999-999999999999',
      createdAt: new Date('2026-09-01T10:00:00Z'),
    }),
  ]
  expect(await turn(4, 'hello')).toBe('hello')
  expect(files[0]?.announcedSeq).toBeNull()
})

// --- a turn that never reached the agent --------------------------------------

// FIXED: `announcedSeq` is stamped in the same transaction as the `pending`
// flip, *before* `query()` is called, and the announcement text is never
// persisted on the message row. A turn that died before the model read the
// prompt used to consume the announcement anyway: the file was marked
// announced and no later turn re-announced it. session-run.worker.ts now
// un-stamps whatever a turn stamped on every path that ends without a normal
// `completed`/`queued` result — see unstampAnnouncement() there. Reproduced
// below by making the SDK query throw immediately, which is what a crashed
// CLI or an OOM kill looks like (the processKill -> recover() seam).
test('a file announced on a turn that died is announced again next turn', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  queryBehaviour = () => throwing('Claude Code process exited with code 143')

  const first = await turn(4)
  expect(first).toContain('[attachments added]')

  queryBehaviour = () => empty()
  const second = await turn(5, 'continue')
  expect(second).toContain('[attachments added]')
})

test('the un-stamp clears announcedSeq and the message_files link the dead turn wrote', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  queryBehaviour = () => throwing('Claude Code process exited with code 143')

  await turn(4)
  // Not left at 4 — the whole point: a turn that died before the model saw
  // the prompt must not spend the file's one announcement.
  expect(files[0]?.announcedSeq).toBeNull()
  expect(messageFileLinks).toEqual([])

  queryBehaviour = () => empty()
  expect(await turn(5, 'continue')).toContain('[attachments added]')
})

test('a file announced on a turn that fails for an unrelated reason is announced again next turn', async () => {
  // The generic catch, not processKill: this message names no signal at all,
  // so processKill() returns undefined and the turn falls through to the
  // plain failure path — which must un-stamp exactly like the kill path does.
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  queryBehaviour = () => throwing('Claude Code returned an error result: something went wrong')

  const first = await turn(4)
  expect(first).toContain('[attachments added]')
  expect(files[0]?.announcedSeq).toBeNull()

  queryBehaviour = () => empty()
  const second = await turn(5, 'continue')
  expect(second).toContain('[attachments added]')
})

test('an interrupted turn (aborted mid-stream) also re-opens what it stamped', async () => {
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  queryBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
      await Promise.resolve()
      throw new Error('aborted')
      // biome-ignore lint/correctness/noUnreachable: shapes the generator's type
      yield undefined
    })()

  const first = await turn(4)
  expect(first).toContain('[attachments added]')
  expect(files[0]?.announcedSeq).toBeNull()
  expect(messageFileLinks).toEqual([])

  queryBehaviour = () => empty()
  const second = await turn(5, 'continue')
  expect(second).toContain('[attachments added]')
})

test('an interrupted turn that ends its stream cleanly also re-opens what it stamped', async () => {
  // The other interrupt seam: the generator finishes instead of throwing, so
  // `runTurn` learns about the interrupt from its own `interrupted` flag after
  // the loop, not from the catch block.
  files = [file({ id: 'f1', createdAt: new Date('2026-09-01T10:00:00Z') })]
  queryBehaviour = () =>
    (async function* () {
      for (const interrupt of interrupters) interrupt({ kind: 'interrupt' })
    })()

  const first = await turn(4)
  expect(first).toContain('[attachments added]')
  expect(files[0]?.announcedSeq).toBeNull()
  expect(messageFileLinks).toEqual([])
})
