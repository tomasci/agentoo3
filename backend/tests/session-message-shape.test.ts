// Defect: three SSE publish sites each built "one message" differently. Two
// (sendMessage in service.ts, appendMessage in the worker) published the raw
// Drizzle row straight off `.returning()` — no `files` key at all. The third
// (listMessages/listMessagePage, and the worker's post-announcement
// `messageDto` republish) went through `toMessageDto` and so always carried
// one. A browser merging a live frame with a replayed one saw a different key
// set depending on which path produced it.
//
// This pins what sendMessage and appendMessage actually publish against
// `sessionMessageSchema` — the declared contract every read path already
// promises — rather than against a second call to listMessages/listMessagePage:
// those are also exported from service.ts, which session-messages.test.ts and
// session-stream.test.ts each register their own mock.module for, process-wide
// and for the rest of the run (see session-stream.test.ts's own comment on the
// hazard). Whichever of those happens to still be active by the time this
// file's tests run would make a from-that-same-module comparison meaningless;
// the schema has no such hazard, and is the more honest target anyway — it is
// what a client is actually promised, not merely what another function returns.
//
// The third publish site — runTurn's post-announcement `messageDto` republish
// in the worker — gets the same key-set check against `sessionMessageSchema`,
// but from tests/attachments-announcement.test.ts rather than from here: it
// only exists inside runTurn's own announcement transaction, and reaching it
// needs that file's heavier fixture (session_files, the SDK query mock), not
// this file's minimal one. Calling `messageDto` directly from here to avoid
// that would import it from service.ts — exactly the module this comment
// already says not to trust a direct call into.
import { beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { getTableName } from 'drizzle-orm'
import { sessionMessageSchema } from '../src/features/sessions/schema'

const B = new URL('../src', import.meta.url).pathname

type Row = Record<string, unknown>

const SESSION_ID = '5a39a43f-6a1e-4a4e-9d70-2f1b0c8e77aa'
const PROJECT_ID = '11111111-2222-4333-8444-555555555555'

let sessionRow: Row
let projectRow: Row
let messageRows: Row[]
const publishedEvents: { kind: string; message?: Row }[] = []

beforeEach(() => {
  sessionRow = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    orchestrator: 'orchestrator',
    status: 'idle',
    nextSeq: 0,
  }
  projectRow = { id: PROJECT_ID, status: 'ready' }
  messageRows = []
  publishedEvents.length = 0
})

// A minimal fake covering exactly the queries sendMessage and appendMessage
// make — one session, one project, no attachments — so this stays about the
// shape of what gets published, not a re-implementation of pagination (see
// session-messages.test.ts) or export (session-export.test.ts) for that.
const db = {
  select: (_fields?: Record<string, unknown>) => {
    let t = ''
    const rowsFor = (): Row[] => {
      if (t === 'sessions') return [sessionRow]
      if (t === 'projects') return [projectRow]
      if (t === 'messages') return messageRows
      if (t === 'message_files') return []
      throw new Error(`fake db: unexpected table ${t}`)
    }
    const q = {
      from(table: unknown) {
        t = getTableName(table as Parameters<typeof getTableName>[0])
        return q
      },
      where: () => q,
      orderBy: () => q,
      limit: async (_n?: number) => rowsFor(),
      then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor()).then(ok, err),
    }
    return q
  },
  update: (t: unknown) => {
    const name = getTableName(t as Parameters<typeof getTableName>[0])
    return {
      set: (payload: Row) => ({
        where: () => ({
          returning: async () => {
            if (name !== 'sessions') return []
            // The atomic seq allocation: RETURNING gives the post-increment
            // value, same as real Postgres — sendMessage subtracts 1 itself.
            if ('nextSeq' in payload) {
              sessionRow.nextSeq = (sessionRow.nextSeq as number) + 1
              return [{ seq: sessionRow.nextSeq }]
            }
            Object.assign(sessionRow, payload)
            return [{ ...sessionRow }]
          },
        }),
      }),
    }
  },
  insert: (t: unknown) => ({
    values: (row: Row) => ({
      returning: async () => {
        if (getTableName(t as Parameters<typeof getTableName>[0]) !== 'messages') return [row]
        // Real Postgres fills in id/createdAt (defaultRandom/defaultNow) and,
        // for any column a caller's `.values()` left out entirely, its column
        // default — `pending` is false, `parentToolUseId` is null. sendMessage
        // never sets the latter at all; toMessageDto (and this schema) expects
        // a real null there, not undefined, same as the worker's own fakes
        // needed a real createdAt once appendMessage started publishing
        // through it instead of the bare row.
        const stamped: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...row }
        stamped.pending ??= false
        stamped.parentToolUseId ??= null
        messageRows.push(stamped)
        return [stamped]
      },
    }),
  }),
}

mock.module(`${B}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

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

// Captured rather than sent anywhere real — this file is about the shape of
// what publishSessionEvent is handed, not about the bus itself (see
// session-stream.test.ts for that). Forwarded-and-overridden, not replaced
// outright, for the same cross-file module-registry reason documented there.
const realEvents = await import(`${B}/lib/events.ts`)
mock.module(`${B}/lib/events.ts`, () => ({
  ...realEvents,
  publishSessionEvent: async (event: { kind: string; message?: Row }) => {
    publishedEvents.push(event)
  },
}))

const { sendMessage } = await import(`${B}/features/sessions/service.ts`)
// appendMessage (the worker's own publish site) needs nothing from the SDK or
// the plugin filesystem — it only inserts a row and publishes it — so it is
// exercised directly here instead of driving a whole fake turn through runTurn
// (see attachments-announcement.test.ts/session-recovery.test.ts for that
// heavier setup, which already covers this path indirectly for many turn
// outcomes but never asserts on the published shape itself).
const { appendMessage } = await import(`${B}/queue/session-run.worker.ts`)

test("sendMessage's published message satisfies the full transcript-message contract", async () => {
  await sendMessage(SESSION_ID, 'clean up the check script')

  const messageEvents = publishedEvents.filter((e) => e.kind === 'message')
  expect(messageEvents).toHaveLength(1)
  const sent = messageEvents[0]?.message as Row

  const result = sessionMessageSchema.safeParse(sent)
  expect(result.success).toBe(true)
  expect(Object.keys(sent).sort()).toEqual(Object.keys(sessionMessageSchema.shape).sort())
  // The historical bug, named explicitly: a raw Drizzle row has no `files` key
  // at all, so a browser could not even ask "is this empty or missing".
  expect(sent.files).toEqual([])
  expect(sent.payload).toEqual({ text: 'clean up the check script' })
})

test("appendMessage's published message satisfies the same contract, same key set", async () => {
  await appendMessage(SESSION_ID, { type: 'system', subtype: 'init' } as never, 'orchestrator')

  const appended = publishedEvents.find((e) => e.kind === 'message')?.message as Row
  const result = sessionMessageSchema.safeParse(appended)
  expect(result.success).toBe(true)
  expect(Object.keys(appended).sort()).toEqual(Object.keys(sessionMessageSchema.shape).sort())
  // The historical bug again, from the worker's side this time: a raw row
  // published straight off `.returning()` had no `files` key at all.
  expect(appended.files).toEqual([])
})
