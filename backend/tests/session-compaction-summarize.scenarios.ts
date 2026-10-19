// summarizeSession and its helpers, against a mocked SDK: Claude Code's own
// /compact on a fork, and the transcript fallback.
//
// A *.scenarios.ts file run by session-compaction-summarize.test.ts in its own
// process: it replaces the SDK with mock.module (see run-isolated.ts), and sets
// SESSION_COMPACTION_* and LEARNING_MODEL before `@/env` is first imported so the
// timeout can be short and the "not LEARNING_*" assertions have something to
// tell apart.
//
// Nothing here can reach Anthropic: forkSession, query and deleteSession are all
// fakes, and every assertion about "what the SDK was asked" reads what the fakes
// recorded.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = await mkdtemp(join(tmpdir(), 'agentoo-compaction-summarize-'))
const LIBRARY = join(ROOT, 'library')
const WORKTREE = join(ROOT, 'worktree')
await mkdir(join(LIBRARY, 'agents'), { recursive: true })
await mkdir(WORKTREE, { recursive: true })
await writeFile(
  join(LIBRARY, 'agents', 'lead.md'),
  '---\nrole: orchestrator\ndescription: Leads\nmodel: opus-test\n---\nYou lead.\n',
)
await writeFile(
  join(LIBRARY, 'agents', 'plain.md'),
  '---\nrole: orchestrator\ndescription: Leads without a model\n---\nYou lead.\n',
)

process.env.LIBRARY_DIR = LIBRARY
process.env.SESSION_COMPACTION_TIMEOUT_MS = '300'
process.env.SESSION_COMPACTION_MAX_BUDGET_USD = '12'
process.env.CLAUDE_CONFIG_DIR = join(ROOT, 'claude-config')
// A learning model that compaction must NOT inherit.
process.env.LEARNING_MODEL = 'learning-model'

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const FORK_ID = 'fork-0000-0000-0000-000000000001'
const SOURCE_SDK_ID = 'source-0000-0000-0000-00000000000a'

type QueryArgs = { prompt: string; options: Record<string, any> }

const calls = {
  fork: [] as { id: string; options: unknown }[],
  query: [] as QueryArgs[],
  deleted: [] as { id: string; options: unknown }[],
}
let forkBehaviour: () => Promise<{ sessionId: string }> = async () => ({ sessionId: FORK_ID })
let deleteBehaviour: () => Promise<void> = async () => {}
let compactBehaviour: (args: QueryArgs) => AsyncIterable<unknown> = () => compactStream({})
let oneShotBehaviour: (args: QueryArgs) => AsyncIterable<unknown> = () => oneShot({})

// compaction.ts reaches the queue module, which builds BullMQ queues and with
// them Redis connections that retry forever against a server that is not there.
// Nothing here enqueues anything, so both are stood down.
mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))
mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  forkSession: async (id: string, options: unknown) => {
    calls.fork.push({ id, options })
    return forkBehaviour()
  },
  deleteSession: async (id: string, options: unknown) => {
    calls.deleted.push({ id, options })
    return deleteBehaviour()
  },
  query: (args: QueryArgs) => {
    calls.query.push(args)
    return args.prompt === '/compact' ? compactBehaviour(args) : oneShotBehaviour(args)
  },
}))

const { cleanSummary, summarizeSession } = await import('@/features/sessions/compaction')

// --- fakes for the stream Claude Code produces -------------------------------------

/**
 * What `query({ prompt: '/compact' })` yields: the PostCompact hook firing (the
 * only place the summary text is handed over), the compact_boundary system
 * message, and the result. Each part can be left out, and the stream can then
 * throw, which is how a dead CLI surfaces.
 */
function compactStream(opts: {
  summary?: string
  boundary?: Record<string, unknown> | false
  result?: Record<string, unknown> | false
  throwAfter?: Error
}) {
  return (async function* (args?: QueryArgs) {
    if (opts.summary !== undefined && args) {
      const matchers = args.options.hooks?.PostCompact ?? []
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          await hook(
            { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: opts.summary },
            undefined,
            { signal: new AbortController().signal },
          )
        }
      }
    }
    if (opts.boundary !== false) {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 90_000, ...opts.boundary },
        uuid: 'u-boundary',
        session_id: FORK_ID,
      }
    }
    if (opts.result !== false) {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        total_cost_usd: 0.31,
        ...opts.result,
      }
    }
    if (opts.throwAfter) throw opts.throwAfter
  })
}

/** Bound to the args at call time, as `query` hands them to the behaviour. */
const compact =
  (opts: Parameters<typeof compactStream>[0]) =>
  (args: QueryArgs): AsyncIterable<unknown> =>
    compactStream(opts)(args)

/** Waits for the abort the timeout fires, then throws as the SDK does. */
const hangUntilAborted = (args: QueryArgs): AsyncIterable<unknown> =>
  (async function* () {
    await new Promise<void>((_, reject) => {
      args.options.abortController.signal.addEventListener('abort', () =>
        reject(new Error('Operation aborted')),
      )
    })
    yield undefined
  })()

/** What the one-shot (fallback) call yields: a structured answer. */
function oneShot(opts: { answer?: unknown; result?: Record<string, unknown> }) {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(opts.answer ?? { summary: 'FALLBACK SUMMARY' }),
      total_cost_usd: 0.05,
      ...opts.result,
    }
  })()
}

// --- fixtures ----------------------------------------------------------------------

const project = { slug: 'demo', name: 'Demo' }

const makeSource = (over: Record<string, unknown> = {}) =>
  ({
    id: 'source-session-id',
    title: 'Add dark mode',
    orchestrator: 'lead',
    status: 'completed',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    totalCostUsd: 2,
    sdkSessionId: SOURCE_SDK_ID,
    worktreePath: WORKTREE,
    branch: 'agentoo/s-aaaaaaaa',
    ...over,
  }) as unknown as Parameters<typeof summarizeSession>[0]

type Row = { seq: number; type: string; parentToolUseId: string | null; payload: Record<string, unknown> }
const TRANSCRIPT: Row[] = [
  { seq: 0, type: 'prompt', parentToolUseId: null, payload: { text: 'Add a dark mode toggle' } },
  {
    seq: 1,
    type: 'assistant',
    parentToolUseId: null,
    payload: { message: { content: [{ type: 'text', text: 'I will edit theme.ts' }] } },
  },
  { seq: 2, type: 'result', parentToolUseId: null, payload: { subtype: 'success', result: 'Done.' } },
]

let transcript: Row[] = TRANSCRIPT
let lastExchange: { request: string | null; reply: string | null } = {
  request: 'Add a dark mode toggle',
  reply: 'The toggle is in Settings.',
}
const ioCalls = { transcript: 0, lastExchange: 0 }
const io = {
  loadTranscript: async () => {
    ioCalls.transcript++
    return transcript
  },
  loadLastExchange: async () => {
    ioCalls.lastExchange++
    return lastExchange
  },
}

const run = (source = makeSource()) => summarizeSession(source, project, io)

const compactCalls = () => calls.query.filter((q) => q.prompt === '/compact')
const oneShotCalls = () => calls.query.filter((q) => q.prompt !== '/compact')

beforeEach(() => {
  calls.fork.length = 0
  calls.query.length = 0
  calls.deleted.length = 0
  forkBehaviour = async () => ({ sessionId: FORK_ID })
  deleteBehaviour = async () => {}
  compactBehaviour = compact({ summary: 'RAW SUMMARY' })
  oneShotBehaviour = () => oneShot({})
  transcript = TRANSCRIPT
  lastExchange = { request: 'Add a dark mode toggle', reply: 'The toggle is in Settings.' }
  ioCalls.transcript = 0
  ioCalls.lastExchange = 0
})

// --- the primary path: /compact on a fork ----------------------------------------------

test('it forks the source in its own directory and compacts the FORK, never the source', async () => {
  const result = await run()

  expect(calls.fork).toEqual([{ id: SOURCE_SDK_ID, options: { dir: WORKTREE } }])
  expect(compactCalls()).toHaveLength(1)
  const [call] = compactCalls()
  expect(call?.options.resume).toBe(FORK_ID)
  // The promise of the whole feature: nothing ever resumes the source's own
  // conversation, so nothing can compact, append to or rewrite it.
  for (const q of calls.query) expect(q.options.resume).not.toBe(SOURCE_SDK_ID)
  expect(result).toMatchObject({ ok: true, method: 'sdk_compact', summary: 'RAW SUMMARY' })
})

test('the /compact query carries exactly the options it is meant to, and none it must not', async () => {
  await run()
  const options = compactCalls()[0]?.options as Record<string, any>

  expect(options.cwd).toBe(WORKTREE)
  expect(options.settingSources).toEqual([])
  expect(options.tools).toEqual([])
  expect(options.strictMcpConfig).toBe(true)
  expect(typeof options.systemPrompt).toBe('string')
  expect(options.maxBudgetUsd).toBe(12)
  expect(options.abortController).toBeInstanceOf(AbortController)
  expect(options.hooks.PostCompact[0].hooks).toHaveLength(1)
  // The orchestrator's own model, from the library.
  expect(options.model).toBe('opus-test')
  // Each of these would change what the call does: verbatimPrompts turns slash
  // commands off, forkSession/persistSession would fork or keep a second copy,
  // and the others are for turns, not for a compaction.
  for (const key of ['verbatimPrompts', 'forkSession', 'persistSession', 'plugins', 'maxTurns']) {
    expect(key in options).toBe(false)
  }
})

test('the subprocess env is an allowlist: PATH, HOME, CLAUDE_CONFIG_DIR and the credential', async () => {
  await run()
  const env = compactCalls()[0]?.options.env as Record<string, string>
  expect(Object.keys(env).sort()).toEqual(
    ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'].sort(),
  )
  expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR as string)
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-not-a-real-token')
  // Nothing else of ours leaks into a process that runs model-directed code.
  expect('DATABASE_URL' in env).toBe(false)
  expect('REDIS_URL' in env).toBe(false)
})

test('an orchestrator with no model of its own sends none, and is not given LEARNING_MODEL', async () => {
  await run(makeSource({ orchestrator: 'plain' }))
  expect('model' in (compactCalls()[0]?.options ?? {})).toBe(false)
})

test('a source with no worktree is forked from the project repo, the way optionsFor runs it', async () => {
  // projectRepo(slug) does not exist on disk here, so this also lands on the
  // fallback; what is under test is only which directory was looked at.
  await run(makeSource({ worktreePath: null }))
  expect(calls.fork).toEqual([])
  // ...and it was missing, so the transcript path ran instead.
  expect(oneShotCalls()).toHaveLength(1)
})

test('the summary comes from PostCompact, cleaned of <analysis> and unwrapped from <summary>', async () => {
  compactBehaviour = compact({
    summary:
      '<analysis>step one\nstep two</analysis>\n<summary>\n1. Goal: dark mode\n2. Done: toggle\n</summary>',
  })
  const result = await run()
  expect(result).toMatchObject({ ok: true, summary: '1. Goal: dark mode\n2. Done: toggle' })
})

test('the cost is the result\'s total_cost_usd', async () => {
  compactBehaviour = compact({ summary: 'S', result: { total_cost_usd: 1.2345 } })
  expect(await run()).toMatchObject({ ok: true, costUsd: 1.2345 })
})

test('a manual compaction that kept the last round appends what it kept', async () => {
  compactBehaviour = compact({
    summary: 'EARLIER WORK',
    boundary: { preserved_messages: { anchor_uuid: 'a', uuids: ['m1', 'm2'] } },
  })
  const result = await run()
  expect(ioCalls.lastExchange).toBe(1)
  expect(result.ok).toBe(true)
  const summary = result.ok ? result.summary : ''
  expect(summary.startsWith('EARLIER WORK')).toBe(true)
  expect(summary).toContain("Operator's last request:\nAdd a dark mode toggle")
  expect(summary).toContain('Final reply:\nThe toggle is in Settings.')
})

test('the older preserved_segment form counts too', async () => {
  compactBehaviour = compact({
    summary: 'EARLIER WORK',
    boundary: { preserved_segment: { head_uuid: 'h', anchor_uuid: 'a', tail_uuid: 't' } },
  })
  const result = await run()
  expect(ioCalls.lastExchange).toBe(1)
  expect(result.ok && result.summary).toContain('Final reply:')
})

test('when everything was summarized there is nothing to append, and nothing is read', async () => {
  compactBehaviour = compact({ summary: 'EVERYTHING' })
  const result = await run()
  expect(ioCalls.lastExchange).toBe(0)
  expect(result).toMatchObject({ ok: true, summary: 'EVERYTHING' })
})

test('a preserved round with only a request, or only a reply, appends just that', async () => {
  compactBehaviour = compact({
    summary: 'S',
    boundary: { preserved_messages: { anchor_uuid: 'a', uuids: ['m1'] } },
  })
  lastExchange = { request: 'only a request', reply: null }
  const requestOnly = await run()
  expect(requestOnly.ok && requestOnly.summary).toContain("Operator's last request:")
  expect(requestOnly.ok && requestOnly.summary).not.toContain('Final reply:')

  lastExchange = { request: null, reply: null }
  const neither = await run()
  expect(neither).toMatchObject({ ok: true, summary: 'S' })
})

// --- the fork is always cleaned up ----------------------------------------------------

test('the fork is deleted after a successful compaction, in the same directory', async () => {
  await run()
  expect(calls.deleted).toEqual([{ id: FORK_ID, options: { dir: WORKTREE } }])
})

test('the fork is deleted even when the stream throws', async () => {
  compactBehaviour = compact({ boundary: false, result: false, throwAfter: new Error('CLI died') })
  const result = await run()
  expect(calls.deleted).toEqual([{ id: FORK_ID, options: { dir: WORKTREE } }])
  expect(result).toMatchObject({ ok: false })
})

test('the fork is deleted when the run times out', async () => {
  compactBehaviour = hangUntilAborted
  await run()
  expect(calls.deleted.map((d) => d.id)).toEqual([FORK_ID])
})

test('a failure to delete the fork is logged and ignored, not turned into a failed compaction', async () => {
  deleteBehaviour = async () => {
    throw new Error('EACCES')
  }
  expect(await run()).toMatchObject({ ok: true, summary: 'RAW SUMMARY' })
})

test('a summary Claude Code handed over survives the stream throwing after it', async () => {
  // The SDK can throw on the pull after it has already delivered everything
  // (see prompt-service.ts); the compaction had succeeded by then.
  compactBehaviour = compact({ summary: 'GOOD', throwAfter: new Error('exit code 1') })
  expect(await run()).toMatchObject({ ok: true, summary: 'GOOD' })
})

// --- when there is nothing to fork: the transcript path ----------------------------------

test('no sdkSessionId goes straight to the transcript summary, forking nothing', async () => {
  const result = await run(makeSource({ sdkSessionId: null }))
  expect(calls.fork).toEqual([])
  expect(compactCalls()).toEqual([])
  expect(calls.deleted).toEqual([])
  expect(oneShotCalls()).toHaveLength(1)
  expect(result).toMatchObject({ ok: true, method: 'transcript_summary', summary: 'FALLBACK SUMMARY' })
})

test('a directory missing on disk goes to the transcript summary', async () => {
  const result = await run(makeSource({ worktreePath: join(ROOT, 'gone') }))
  expect(calls.fork).toEqual([])
  expect(result).toMatchObject({ ok: true, method: 'transcript_summary' })
})

for (const message of [
  'Session abc not found in project directory for /work/tree',
  'Session abc has no messages to fork',
  'Invalid sessionId: nope',
]) {
  test(`forkSession saying "${message.slice(0, 40)}..." falls back to the transcript summary`, async () => {
    forkBehaviour = async () => {
      throw new Error(message)
    }
    const result = await run()
    expect(compactCalls()).toEqual([])
    expect(oneShotCalls()).toHaveLength(1)
    expect(result).toMatchObject({ ok: true, method: 'transcript_summary' })
    // There is no fork to delete when it was never made.
    expect(calls.deleted).toEqual([])
  })
}

test('any OTHER fork failure fails the compaction instead of falling back', async () => {
  forkBehaviour = async () => {
    throw new Error('EACCES: permission denied, open /home/x/.claude/projects/y/z.jsonl')
  }
  const result = await run()
  expect(result.ok).toBe(false)
  expect(!result.ok && result.reason).toContain('EACCES')
  expect(compactCalls()).toEqual([])
  expect(oneShotCalls()).toEqual([])
})

test('"Not enough messages to compact." falls back, keeping what was spent, and still cleans up', async () => {
  compactBehaviour = compact({
    boundary: false,
    result: { result: 'Not enough messages to compact.', total_cost_usd: 0.02 },
  })
  const result = await run()
  expect(calls.deleted.map((d) => d.id)).toEqual([FORK_ID])
  expect(oneShotCalls()).toHaveLength(1)
  // 0.02 from the attempt that found nothing to do, plus 0.05 from the summary call.
  expect(result).toMatchObject({ ok: true, method: 'transcript_summary' })
  expect(result.ok && result.costUsd).toBeCloseTo(0.07, 10)
})

// --- what must NOT fall back ------------------------------------------------------------------

const failuresThatMustNotFallBack: [string, () => void, RegExp][] = [
  [
    'an is_error result',
    () => {
      compactBehaviour = compact({
        boundary: false,
        result: { is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0.4 },
      })
    },
    /529 overloaded/,
  ],
  [
    'an error_* subtype',
    () => {
      compactBehaviour = compact({
        boundary: false,
        result: {
          subtype: 'error_max_budget_usd',
          is_error: true,
          errors: [],
          result: undefined,
          total_cost_usd: 12.5,
        },
      })
    },
    /error_max_budget_usd/,
  ],
  [
    'the stream throwing with no result',
    () => {
      compactBehaviour = compact({ boundary: false, result: false, throwAfter: new Error('CLI died') })
    },
    /CLI died/,
  ],
  [
    'a timeout',
    () => {
      compactBehaviour = hangUntilAborted
    },
    /300ms timeout/,
  ],
  [
    'a compact boundary with no summary captured',
    () => {
      compactBehaviour = compact({})
    },
    /delivered no summary/,
  ],
  [
    'a summary that is only <analysis>',
    () => {
      compactBehaviour = compact({ summary: '<analysis>only thinking</analysis>' })
    },
    /delivered no summary/,
  ],
  [
    'wording this code does not recognise (fail closed)',
    () => {
      compactBehaviour = compact({ boundary: false, result: { result: 'Nothing to do here.' } })
    },
    /did not compact the conversation: Nothing to do here\./,
  ],
  [
    'a "Not enough messages" result that also carries a boundary',
    () => {
      compactBehaviour = compact({ result: { result: 'Not enough messages to compact.' } })
    },
    /did not compact|delivered no summary/,
  ],
  [
    'no result at all',
    () => {
      compactBehaviour = compact({ boundary: false, result: false })
    },
    /without a result/,
  ],
]

for (const [name, arrange, reason] of failuresThatMustNotFallBack) {
  test(`${name} fails the compaction and does NOT spend more on the fallback`, async () => {
    arrange()
    const result = await run()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(reason)
    expect(oneShotCalls()).toEqual([])
    expect(ioCalls.transcript).toBe(0)
    // Still cleaned up.
    expect(calls.deleted.map((d) => d.id)).toEqual([FORK_ID])
  })
}

test('a failed run reports what it had already spent', async () => {
  compactBehaviour = compact({
    boundary: false,
    result: { is_error: true, result: 'overloaded', total_cost_usd: 0.4 },
  })
  expect(await run()).toMatchObject({ ok: false, costUsd: 0.4 })
})

test('the timeout is SESSION_COMPACTION_TIMEOUT_MS, and the run is abortable by it', async () => {
  compactBehaviour = hangUntilAborted
  const started = Date.now()
  const result = await run()
  const took = Date.now() - started
  expect(result.ok).toBe(false)
  expect(took).toBeGreaterThanOrEqual(250)
  expect(took).toBeLessThan(5_000)
})

// --- the transcript summary ----------------------------------------------------------------------

test('the fallback asks for a continuable summary of the stored transcript, in one tool-less call', async () => {
  await run(makeSource({ sdkSessionId: null }))
  const [call] = oneShotCalls()
  expect(call?.prompt).toContain('Add a dark mode toggle')
  expect(call?.prompt).toContain('I will edit theme.ts')
  expect(String(call?.options.systemPrompt)).toMatch(/fresh agent/)
  expect(String(call?.options.systemPrompt)).toMatch(/latest request/i)
  expect(call?.options.tools).toEqual([])
  expect(call?.options.persistSession).toBe(false)
  expect(call?.options.outputFormat.schema.required).toEqual(['summary'])
})

test('the fallback is governed by SESSION_COMPACTION_*, not LEARNING_*', async () => {
  await run(makeSource({ sdkSessionId: null, orchestrator: 'plain' }))
  const [call] = oneShotCalls()
  // 12 is SESSION_COMPACTION_MAX_BUDGET_USD; LEARNING_CALL_BUDGET_USD is 2.
  expect(call?.options.maxBudgetUsd).toBe(12)
  // And with no model of its own it uses the SDK's default, not LEARNING_MODEL.
  expect('model' in (call?.options ?? {})).toBe(false)
})

test('the fallback uses the orchestrator\'s model when it has one', async () => {
  await run(makeSource({ sdkSessionId: null }))
  expect(oneShotCalls()[0]?.options.model).toBe('opus-test')
})

test('the fallback times out at SESSION_COMPACTION_TIMEOUT_MS, not LEARNING_CALL_TIMEOUT_MS', async () => {
  oneShotBehaviour = hangUntilAborted
  const started = Date.now()
  const result = await run(makeSource({ sdkSessionId: null }))
  expect(result.ok).toBe(false)
  expect(!result.ok && result.reason).toContain('300ms')
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('it asks for a bigger digest than learning does', async () => {
  transcript = [
    { seq: 0, type: 'prompt', parentToolUseId: null, payload: { text: 'p'.repeat(1900) } },
  ]
  await run(makeSource({ sdkSessionId: null }))
  // Learning caps one item at 500 characters; this one fits whole.
  expect(oneShotCalls()[0]?.prompt).toContain('p'.repeat(1900))
})

test('a session with no messages at all has nothing to compact, and costs nothing', async () => {
  transcript = []
  const result = await run(makeSource({ sdkSessionId: null }))
  expect(result).toEqual({
    ok: false,
    reason: 'This session has nothing to compact yet',
    costUsd: 0,
  })
  expect(oneShotCalls()).toEqual([])
})

test('a session that was itself a compaction carries its earlier summary into the next one', async () => {
  transcript = [
    {
      seq: 0,
      type: 'compact_context',
      parentToolUseId: null,
      payload: { summary: 'THE FIRST SUMMARY', sourceSessionId: 'older' },
    },
    ...TRANSCRIPT.map((r) => ({ ...r, seq: r.seq + 1 })),
  ]
  await run(makeSource({ sdkSessionId: null }))
  expect(oneShotCalls()[0]?.prompt).toContain('THE FIRST SUMMARY')
  expect(oneShotCalls()[0]?.prompt).toContain('Add a dark mode toggle')
})

test('a session that only has an earlier summary and nothing since still compacts', async () => {
  transcript = [
    {
      seq: 0,
      type: 'compact_context',
      parentToolUseId: null,
      payload: { summary: 'THE FIRST SUMMARY', sourceSessionId: 'older' },
    },
  ]
  const result = await run(makeSource({ sdkSessionId: null }))
  expect(result.ok).toBe(true)
  expect(oneShotCalls()[0]?.prompt).toContain('THE FIRST SUMMARY')
})

test('a fallback call that fails reports its reason and cost, and an off-shape answer is a failure', async () => {
  oneShotBehaviour = () =>
    oneShot({ result: { is_error: true, result: 'quota exceeded', total_cost_usd: 0.3 } })
  expect(await run(makeSource({ sdkSessionId: null }))).toMatchObject({
    ok: false,
    reason: 'quota exceeded',
    costUsd: 0.3,
  })

  oneShotBehaviour = () => oneShot({ answer: { summary: 42 } })
  const offShape = await run(makeSource({ sdkSessionId: null }))
  expect(offShape.ok).toBe(false)
  expect(!offShape.ok && offShape.reason).toContain('expected shape')

  oneShotBehaviour = () => oneShot({ answer: { summary: '<analysis>x</analysis>   ' } })
  const empty = await run(makeSource({ sdkSessionId: null }))
  expect(empty).toMatchObject({ ok: false, reason: 'The model returned an empty summary' })
})

test('it never throws: a database that cannot be read is a failed result', async () => {
  const broken = {
    loadTranscript: async () => {
      throw new Error('connection terminated')
    },
    loadLastExchange: async () => ({ request: null, reply: null }),
  }
  const result = await summarizeSession(makeSource({ sdkSessionId: null }), project, broken)
  expect(result).toMatchObject({ ok: false })
  expect(!result.ok && result.reason).toContain('connection terminated')
})

// --- cleanSummary --------------------------------------------------------------------------------

test('cleanSummary strips the scratchpad and unwraps the summary', () => {
  expect(cleanSummary('<analysis>a</analysis><summary>b</summary>')).toBe('b')
  expect(cleanSummary('<analysis>a\nb</analysis>\n\nplain text\n')).toBe('plain text')
  expect(cleanSummary('  just text  ')).toBe('just text')
  expect(cleanSummary('<SUMMARY>shouting</SUMMARY>')).toBe('shouting')
})

test('cleanSummary reads an unclosed tag as running to the end, so a truncated scratchpad is no summary', () => {
  expect(cleanSummary('<summary>cut off mid')).toBe('cut off mid')
  expect(cleanSummary('before <analysis>cut off mid')).toBe('before')
  expect(cleanSummary('<analysis>cut off mid')).toBe('')
})
