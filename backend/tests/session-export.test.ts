import { beforeEach, expect, mock, test } from 'bun:test'
// First, before anything that reaches `@/env`: the parsed environment is shared
// across test files, so DATABASE_URL/REDIS_URL have to be final before any src
// module loads. See tests/setup-env.ts.
import './setup-env'
import { getTableName } from 'drizzle-orm'

const B = new URL('../src', import.meta.url).pathname

// --- fixtures -----------------------------------------------------------------

const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = '5a39a43f-6a1e-4a4e-9d70-2f1b0c8e77aa'
const ID8 = '5a39a43f'

/** An Agent SDK resume handle. Must never appear in a document handed out. */
const SDK_HANDLE = 'sdk-1f0d2c3b-resume-handle'
/** An absolute server path, i.e. PROJECTS_DIR and the project slug. */
const WORKTREE = '/nonexistent-agentoo-projects-dir/agentoo/worktrees/5a39a43f'

type Row = Record<string, unknown>

const baseSession = (): Row => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'clean up check',
  status: 'completed',
  orchestrator: 'orchestrator',
  worktreePath: WORKTREE,
  branch: 'agentoo/s-5a39a43f',
  sdkSessionId: SDK_HANDLE,
  maxBudgetUsd: 5,
  lastError: null,
  totalCostUsd: 1.2345,
  nextSeq: 4,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-01T10:42:00.000Z'),
})

const baseProject = (): Row => ({
  id: PROJECT_ID,
  name: 'Agentoo',
  slug: 'agentoo',
  source: 'clone',
  status: 'ready',
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  updatedAt: new Date('2026-08-01T09:00:00.000Z'),
})

// Payloads are stored verbatim by the worker and must come back out untouched,
// so the fixture is synthetic rather than copied from the database: every real
// stored `thinking` block currently has empty text (upstream capture
// behaviour), which would make a "thinking survives" assertion pass vacuously.
const PROMPT_PAYLOAD = { text: 'clean up the check script' }
const ASSISTANT_PAYLOAD = {
  type: 'assistant',
  message: {
    id: 'msg_01',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'The check script shells out twice; one call is enough.',
        signature: 'sig-abc',
      },
      { type: 'text', text: 'Removing the duplicate call.' },
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Edit',
        input: { file_path: 'check.sh', old_string: 'run run', new_string: 'run' },
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 96 },
  },
}
const TOOL_RESULT_PAYLOAD = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: 'Applied 1 edit' },
    ],
  },
}
const RESULT_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  num_turns: 2,
  total_cost_usd: 1.2345,
  usage: { input_tokens: 1200, output_tokens: 96 },
}

const message = (seq: number, over: Row): Row => ({
  id: `00000000-0000-4000-8000-00000000000${seq}`,
  sessionId: SESSION_ID,
  seq,
  type: 'assistant',
  pending: false,
  parentToolUseId: null,
  title: null,
  payload: {},
  createdAt: new Date(`2026-09-01T10:0${seq}:00.000Z`),
  ...over,
})

/**
 * Stored deliberately out of order.
 *
 * The fake below only sorts when the query asks it to, so a transcript that
 * arrives in seq order proves `listMessages` ordered it rather than proving the
 * fixture happened to be sorted.
 */
const storedMessages = (): Row[] => [
  message(2, { type: 'user', parentToolUseId: 'toolu_01', payload: TOOL_RESULT_PAYLOAD }),
  message(0, { type: 'prompt', pending: true, payload: PROMPT_PAYLOAD }),
  message(3, { type: 'result', payload: RESULT_PAYLOAD }),
  message(1, { type: 'assistant', title: 'orchestrator: Edit', payload: ASSISTANT_PAYLOAD }),
]

// --- a database that answers the four queries the export makes -----------------

let sessionRow: Row | undefined
let projectRow: Row | undefined
let transcript: Row[]

beforeEach(() => {
  sessionRow = baseSession()
  projectRow = baseProject()
  transcript = storedMessages()
})

function rowsFor(table: string, aggregate: boolean, sortedBySeq: boolean): Row[] {
  // countsFor and pendingFor are the only projected selects and both group by
  // session. One answer serves both: pendingPrompts is not part of the export,
  // so nothing here depends on which of the two ran first.
  if (aggregate) return sessionRow ? [{ sessionId: sessionRow.id, n: transcript.length }] : []
  if (table === 'sessions') return sessionRow ? [sessionRow] : []
  if (table === 'projects') return projectRow ? [projectRow] : []
  if (table === 'messages') {
    return sortedBySeq
      ? [...transcript].sort((a, b) => (a.seq as number) - (b.seq as number))
      : transcript
  }
  throw new Error(`fake db: unexpected table ${table}`)
}

function select(fields?: Record<string, unknown>) {
  let table = ''
  let sortedBySeq = false
  const builder = {
    from(t: unknown) {
      table = getTableName(t as Parameters<typeof getTableName>[0])
      return builder
    },
    where: () => builder,
    limit: () => builder,
    groupBy: () => builder,
    orderBy: (...columns: unknown[]) => {
      sortedBySeq = columns.some((c) => (c as { name?: string })?.name === 'seq')
      return builder
    },
    // Drizzle's builders are thenable, which is what makes `await db.select()...`
    // work without a .execute().
    then: (ok?: (rows: Row[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(table, fields !== undefined, sortedBySeq)).then(ok, err),
  }
  return builder
}

mock.module(`${B}/db/client.ts`, () => ({
  db: { select },
  closeDb: async () => {},
}))

// The queue builds its BullMQ queues at module scope and connects to Redis
// there; the export path never touches it, so it is stubbed rather than pointed
// at a server. Every export the service chain names has to be present, or the
// import fails while loading.
mock.module(`${B}/queue/index.ts`, () => ({
  QUEUE_PROJECT_SETUP: 'project-setup',
  QUEUE_SESSION_RUN: 'session-run',
  redisConnection: () => ({}),
  projectSetupQueue: {},
  sessionRunQueue: {},
  enqueueProjectSetup: async () => ({}),
  enqueueSessionRun: async () => ({}),
}))

const { exportSession, getSession, sessionExportFileName } = await import(
  `${B}/features/sessions/service.ts`
)
const { VERSION } = await import(`${B}/lib/version.ts`)

// --- the filename ------------------------------------------------------------

// The route interpolates this straight into `filename="..."` with no escaping,
// so the character class is a security property, not a cosmetic one.
const SAFE = /^[a-z0-9-]+\.json$/
const fileName = (title: string | null, id = SESSION_ID) => sessionExportFileName({ id, title })

test('a titled session is named agentoo-session-<slug>-<id8>.json', () => {
  expect(fileName('clean up check')).toBe(`agentoo-session-clean-up-check-${ID8}.json`)
})

test('a session with no title drops the slug rather than inventing one', () => {
  expect(fileName(null, 'f26535ce-bfee-4486-a15f-9a7ea682d90c')).toBe(
    'agentoo-session-f26535ce.json',
  )
  expect(fileName('')).toBe(`agentoo-session-${ID8}.json`)
  expect(fileName('   ')).toBe(`agentoo-session-${ID8}.json`)
  expect(fileName('---')).toBe(`agentoo-session-${ID8}.json`)
})

/**
 * Titles are user input and reach an HTTP header, so each of these has to come
 * out as one filename in one header line.
 *
 * Assertions carry the label and a boolean rather than the filename itself: a
 * failure message that echoed the raw title back would put a control character
 * into the transcript, which cannot be stored.
 */
const hostile: { label: string; title: string }[] = [
  { label: 'double quote', title: 'say "hi" now' },
  { label: 'quote closing the header value', title: '"; filename="owned' },
  { label: 'backslash', title: 'a\\b' },
  { label: 'forward slash', title: 'etc/passwd' },
  { label: 'parent directory', title: '../../etc/passwd' },
  { label: 'CRLF header injection', title: 'evil\r\nX-Injected: yes' },
  { label: 'tab and newline', title: 'a\tb\nc' },
  { label: 'emoji', title: 'ship it \u{1F680}' },
  { label: 'full-width unicode', title: 'ＦＵＬＬ　ＷＩＤＴＨ' },
  { label: 'accented latin', title: 'Café déjà vu' },
  // Built here rather than typed: a raw one would kill the process that stores
  // this transcript. It is a plausible title byte all the same, arriving
  // through a JSON request body.
  { label: 'embedded character code 0', title: `a${String.fromCharCode(0)}b` },
  { label: 'only character code 0', title: String.fromCharCode(0) },
]

test('a hostile title cannot escape the quoted Content-Disposition value', () => {
  for (const { label, title } of hostile) {
    const got = fileName(title)
    expect(`${label}: ${SAFE.test(got)}`).toBe(`${label}: true`)

    // Exactly what routes.ts builds, so this fails if the filename ever gains a
    // quote or a line break.
    const header = `attachment; filename="${got}"`
    expect(`${label}: ${header.split(/\r|\n/).length} lines`).toBe(`${label}: 1 lines`)
    expect(`${label}: ${header.match(/"/g)?.length} quotes`).toBe(`${label}: 2 quotes`)
    expect(`${label}: ${got.endsWith(`${ID8}.json`)}`).toBe(`${label}: true`)
  }
})

test('punctuation and unicode collapse to the documented slug', () => {
  expect(fileName('say "hi" now')).toBe(`agentoo-session-say-hi-now-${ID8}.json`)
  expect(fileName('etc/passwd')).toBe(`agentoo-session-etc-passwd-${ID8}.json`)
  expect(fileName('../../etc/passwd')).toBe(`agentoo-session-etc-passwd-${ID8}.json`)
  expect(fileName('evil\r\nX-Injected: yes')).toBe(
    `agentoo-session-evil-x-injected-yes-${ID8}.json`,
  )
  expect(fileName('a\tb\nc')).toBe(`agentoo-session-a-b-c-${ID8}.json`)
  expect(fileName('ship it \u{1F680}')).toBe(`agentoo-session-ship-it-${ID8}.json`)
  // NFKD folds full-width forms onto ASCII, so these stay readable.
  expect(fileName('ＦＵＬＬ　ＷＩＤＴＨ')).toBe(
    `agentoo-session-full-width-${ID8}.json`,
  )
  // Accents decompose to combining marks, which are separators rather than
  // nothing: "déjà" becomes de-ja. Lossy, but safe and stable.
  expect(fileName('Café déjà vu')).toBe(`agentoo-session-cafe-de-ja-vu-${ID8}.json`)
  expect(fileName(`a${String.fromCharCode(0)}b`)).toBe(`agentoo-session-a-b-${ID8}.json`)
})

test('a title with no latin letters falls back to the id, not to "project"', () => {
  // The app ships an ru locale, so this is an ordinary title. toSlug's
  // `slug || 'project'` fallback would name the wrong noun here.
  const got = fileName('Тестовая сессия')
  expect(got).toBe(`agentoo-session-${ID8}.json`)
  expect(got).not.toContain('project')
  expect(fileName('日本語のセッション')).toBe(`agentoo-session-${ID8}.json`)
})

test('a long title is truncated without leaving a hyphen against the id', () => {
  // 59 letters then a space: the 60-character cut lands exactly on the hyphen
  // that word break became, which is the case that produced `...a--5a39a43f`.
  const head = 'a'.repeat(59)
  const got = fileName(`${head} tail`)
  expect(got).toBe(`agentoo-session-${head}-${ID8}.json`)
  expect(got).not.toContain('--')
  expect(got).toMatch(SAFE)

  // A cut mid-word keeps all 60 characters.
  expect(fileName('b'.repeat(70))).toBe(`agentoo-session-${'b'.repeat(60)}-${ID8}.json`)
})

test('an uppercase id still yields a header-safe filename', () => {
  const got = sessionExportFileName({ id: '5A39A43F-6A1E-4A4E-9D70-2F1B0C8E77AA', title: null })

  // Hex either way, so nothing can be injected; the id is passed through
  // as stored rather than case-folded, which is why this compares lowercased.
  // Postgres renders uuid lowercase, so the strict /^[a-z0-9-]+\.json$/ in the
  // docstring holds for every id that reaches this in production.
  expect(got.toLowerCase()).toBe('agentoo-session-5a39a43f.json')
  expect(`attachment; filename="${got}"`.match(/["/\\\r\n]/g)).toEqual(['"', '"'])
})

// --- the document -------------------------------------------------------------

const SESSION_KEYS = [
  'branch',
  'createdAt',
  'id',
  'isolated',
  'lastError',
  'maxBudgetUsd',
  'messageCount',
  'orchestrator',
  'projectId',
  'projectName',
  'status',
  'title',
  'totalCostUsd',
  'updatedAt',
]

const MESSAGE_KEYS = [
  'createdAt',
  'parentToolUseId',
  'payload',
  'pending',
  'seq',
  'title',
  'type',
]

test('the document is a self-describing agentoo envelope', async () => {
  const doc = await exportSession(SESSION_ID)

  expect(doc.kind).toBe('agentoo.session-export')
  expect(doc.formatVersion).toBe(1)
  expect(doc.generator).toEqual({ app: 'agentoo', version: VERSION })
  expect(doc.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expect(Math.abs(Date.parse(doc.exportedAt) - Date.now())).toBeLessThan(60_000)
  expect(Object.keys(doc).sort()).toEqual([
    'exportedAt',
    'formatVersion',
    'generator',
    'kind',
    'messages',
    'session',
  ])
})

test('the session block carries exactly the documented fields', async () => {
  const doc = await exportSession(SESSION_ID)

  expect(Object.keys(doc.session).sort()).toEqual(SESSION_KEYS)
  expect(doc.session).toEqual({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    projectName: 'Agentoo',
    title: 'clean up check',
    status: 'completed',
    orchestrator: 'orchestrator',
    branch: 'agentoo/s-5a39a43f',
    isolated: true,
    maxBudgetUsd: 5,
    totalCostUsd: 1.2345,
    lastError: null,
    messageCount: 4,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:42:00.000Z',
  })
})

test('host-only state never reaches the document', async () => {
  // The likeliest regression is someone replacing the field-by-field
  // construction with a spread of the DTOs. TypeScript would not object: the
  // export types are structural, and extra keys survive a spread.
  // Pinned against the DTO the export is built from, so this stays a real
  // subtraction rather than passing because the fields stopped existing.
  const dto = await getSession(SESSION_ID)
  expect(dto.sdkSessionId).toBe(SDK_HANDLE)
  expect(dto.worktreePath).toBe(WORKTREE)
  expect(dto.workingDir).toBe(WORKTREE)

  const doc = await exportSession(SESSION_ID)

  expect('sdkSessionId' in doc.session).toBe(false)
  expect('worktreePath' in doc.session).toBe(false)
  expect('workingDir' in doc.session).toBe(false)
  // branch is deliberately kept: it is a git ref the UI already shows.
  expect(doc.session.branch).toBe('agentoo/s-5a39a43f')

  for (const m of doc.messages) {
    expect(Object.keys(m).sort()).toEqual(MESSAGE_KEYS)
    expect('id' in m).toBe(false)
    expect('sessionId' in m).toBe(false)
  }

  // Whole-document sweep, so a leak through a nested field is caught too.
  const wire = JSON.stringify(doc)
  expect(wire).not.toContain(SDK_HANDLE)
  expect(wire).not.toContain(WORKTREE)
  expect(wire).not.toContain('/nonexistent-agentoo-projects-dir')
})

test('message payloads are emitted verbatim', async () => {
  const doc = await exportSession(SESSION_ID)

  expect(doc.messages.map((m: { payload: unknown }) => m.payload)).toEqual([
    PROMPT_PAYLOAD,
    ASSISTANT_PAYLOAD,
    TOOL_RESULT_PAYLOAD,
    RESULT_PAYLOAD,
  ])

  // Named explicitly because these are the blocks an export exists to preserve
  // and the ones a "tidy the payload" change would drop first.
  const blocks = doc.messages[1].payload.message.content
  expect(blocks[0]).toEqual({
    type: 'thinking',
    thinking: 'The check script shells out twice; one call is enough.',
    signature: 'sig-abc',
  })
  expect(blocks[2].input.old_string).toBe('run run')
  expect(doc.messages[2].payload.message.content[0].tool_use_id).toBe('toolu_01')
  expect(doc.messages[3].payload.total_cost_usd).toBe(1.2345)
})

test('the whole transcript is exported in seq order', async () => {
  const doc = await exportSession(SESSION_ID)

  expect(doc.messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1, 2, 3])
  expect(doc.messages).toHaveLength(transcript.length)
  expect(doc.messages[0]).toEqual({
    seq: 0,
    type: 'prompt',
    parentToolUseId: null,
    title: null,
    pending: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    payload: PROMPT_PAYLOAD,
  })
  expect(doc.messages[2].parentToolUseId).toBe('toolu_01')
  expect(doc.messages[1].title).toBe('orchestrator: Edit')
})

test('a session with no messages exports an empty transcript, not an error', async () => {
  transcript = []
  const doc = await exportSession(SESSION_ID)

  expect(doc.messages).toEqual([])
  expect(doc.session.messageCount).toBe(0)
})

test('a session sharing the checkout reports isolated=false and still hides the path', async () => {
  sessionRow = { ...baseSession(), worktreePath: null, branch: null }
  const doc = await exportSession(SESSION_ID)

  expect(doc.session.isolated).toBe(false)
  expect(doc.session.branch).toBeNull()
  // workingDir falls back to the project checkout in the DTO; the export must
  // still not carry it.
  expect('workingDir' in doc.session).toBe(false)
  expect(JSON.stringify(doc)).not.toContain('/nonexistent-agentoo-projects-dir')
})

test('a failed session exports its error and null budget', async () => {
  sessionRow = {
    ...baseSession(),
    title: null,
    status: 'failed',
    orchestrator: null,
    maxBudgetUsd: null,
    lastError: 'Worktree unavailable: fatal: not a git repository',
  }
  const doc = await exportSession(SESSION_ID)

  expect(doc.session.title).toBeNull()
  expect(doc.session.status).toBe('failed')
  expect(doc.session.orchestrator).toBeNull()
  expect(doc.session.maxBudgetUsd).toBeNull()
  expect(doc.session.lastError).toBe('Worktree unavailable: fatal: not a git repository')
  expect(sessionExportFileName(doc.session)).toBe(`agentoo-session-${ID8}.json`)
})

test('an unknown session id fails as a 404 before any document is built', async () => {
  sessionRow = undefined
  const error = await exportSession('99999999-9999-4999-8999-999999999999').catch(
    (e: unknown) => e,
  )

  expect((error as Error).message).toBe('Session not found')
  expect((error as { status: number }).status).toBe(404)
})

test('a session whose project row is gone fails as a 404', async () => {
  projectRow = undefined
  const error = await exportSession(SESSION_ID).catch((e: unknown) => e)

  expect((error as Error).message).toBe('Project not found')
  expect((error as { status: number }).status).toBe(404)
})
