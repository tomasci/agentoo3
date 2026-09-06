// Adversarial probes at attachmentsHook, and the two-matcher PreToolUse wiring.
//
// attachments-hook.test.ts covers the shapes the hook was written for. This
// file covers the shapes an agent that wants another session's files would
// actually send: traversal inside a Bash command string, traversal in a tool
// path, a relative path that climbs out of cwd into the store, prefix
// confusion, and every fail-closed branch. It also pins the invariant that the
// non-deny return is silence — a `permissionDecision: 'allow'` here would
// auto-approve every file tool in the system, not just the attachments ones.

import { expect, test } from 'bun:test'
import './setup-env'
import { relative } from 'node:path'
import { env } from '../src/env'
import { attachmentsHook, delegationHook } from '../src/features/sessions/runner-options'

const ROOT = env.ATTACHMENTS_DIR
const OWN_ID = 'ab120000-0000-0000-0000-000000000000'
const OTHER_ID = 'cd340000-0000-0000-0000-000000000000'
const OWN = `${ROOT}/sessions/ab/12/${OWN_ID}/uploads`
const OTHER = `${ROOT}/sessions/cd/34/${OTHER_ID}/uploads`
const CWD = '/opt/agentoo/projects/demo/worktrees/sess-1'

type Decision = { permissionDecision?: string; permissionDecisionReason?: string } | undefined

const call = (
  matcher: ReturnType<typeof attachmentsHook>,
  tool: string,
  input: unknown,
  cwd = CWD,
) => {
  const hook = matcher.hooks[0]
  if (!hook) throw new Error('hook registered no callback')
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
      tool_use_id: 'toolu_test',
      cwd,
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
    } as never,
    'toolu_test',
    { signal: AbortSignal.timeout(1000) },
  )
}

const own = (tool: string, input: unknown, cwd?: string) =>
  call(attachmentsHook(OWN), tool, input, cwd)

const decision = (out: unknown): Decision =>
  (out as { hookSpecificOutput?: Decision } | undefined)?.hookSpecificOutput

// --- traversal in a tool path -------------------------------------------------

test('Read climbing out of the own uploads dir with .. into a sibling session is denied', async () => {
  const escape = `${OWN}/../../../../cd/34/${OTHER_ID}/uploads/secret.log`
  expect(decision(await own('Read', { file_path: escape }))?.permissionDecision).toBe('deny')
})

test('Read climbing to the storage root itself is denied', async () => {
  expect(decision(await own('Read', { file_path: `${OWN}/../../../..` }))?.permissionDecision).toBe(
    'deny',
  )
})

test('a relative path that climbs out of cwd into another session is denied', async () => {
  // No absolute path anywhere in the tool input — the guard has to resolve it
  // against cwd before deciding, which is the whole point of `resolve(cwd, raw)`.
  const rel = relative(CWD, `${OTHER}/secret.log`)
  expect(rel.startsWith('..')).toBe(true)
  expect(decision(await own('Read', { file_path: rel }))?.permissionDecision).toBe('deny')
})

test('a relative path resolving back into the own uploads dir is silent', async () => {
  const rel = relative(CWD, `${OWN}/error.log`)
  expect(await own('Read', { file_path: rel })).toEqual({})
})

test('a sibling directory sharing the own uploads dir as a name prefix is denied', async () => {
  // `${OWN}_stolen` starts with the own dir's string but is not inside it — a
  // startsWith() without the separator would let this through.
  expect(
    decision(await own('Read', { file_path: `${OWN}_stolen/x.log` }))?.permissionDecision,
  ).toBe('deny')
})

test('the session directory above the own uploads dir is not granted', async () => {
  // additionalDirectories grants uploads/, never the session dir that holds it.
  expect(
    decision(await own('Read', { file_path: `${ROOT}/sessions/ab/12/${OWN_ID}/notes.txt` }))
      ?.permissionDecision,
  ).toBe('deny')
})

// --- traversal in a Bash command string --------------------------------------

// FIXED: everyRootUseIsOwn() in runner-options.ts used to compare the command
// text at each occurrence of the storage root against `root + ownSuffix` as a
// raw string slice, and never normalised the path. A command whose only
// mention of the root *started* with this session's own uploads dir and then
// climbed out of it with `..` matched that prefix, so the hook returned
// silence and the read was allowed. Input:
//   cat <OWN>/../../../../cd/34/<OTHER_ID>/uploads/secret.log
// Now resolved and checked with the same containment predicate the path-tool
// branch already used (see isWithin() in runner-options.ts), same as the Read
// case above.
test('a Bash command climbing out of the own uploads dir with .. is denied', async () => {
  const command = `cat ${OWN}/../../../../cd/34/${OTHER_ID}/uploads/secret.log`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

test('a Bash command climbing from the own dir to the storage root is denied', async () => {
  const command = `ls -R ${OWN}/../../../../..`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

test('a Bash command naming another session outright is denied', async () => {
  const command = `grep -r password ${OTHER}`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

test('a Bash command that cds into the storage root is denied', async () => {
  const command = `cd ${ROOT} && find . -name '*.log'`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

test('a Bash command mentioning the own dir twice is silent', async () => {
  const command = `wc -l ${OWN}/a.log && tail -n 20 ${OWN}/b.log`
  expect(await own('Bash', { command })).toEqual({})
})

test('a Bash command mixing the own dir with a sibling session is denied', async () => {
  const command = `cat ${OWN}/a.log ${OTHER}/b.log`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

test('a Bash command with the sibling first and the own dir second is still denied', async () => {
  // The loop has to keep scanning past the first match, not stop at it.
  const command = `cat ${OTHER}/b.log ${OWN}/a.log`
  expect(decision(await own('Bash', { command }))?.permissionDecision).toBe('deny')
})

// --- a session with nothing of its own ----------------------------------------

test('ownUploadsDir null denies every guarded tool under the root, and Bash with it', async () => {
  const none = attachmentsHook(null)
  for (const [tool, input] of [
    ['Read', { file_path: `${OWN}/error.log` }],
    ['Grep', { pattern: 'x', path: OWN }],
    ['Glob', { path: `${ROOT}/**` }],
    ['Edit', { file_path: `${OWN}/error.log` }],
    ['Write', { file_path: `${ROOT}/x` }],
    ['NotebookRead', { notebook_path: `${OWN}/x.ipynb` }],
    ['NotebookEdit', { notebook_path: `${OWN}/x.ipynb` }],
  ] as const) {
    expect(decision(await call(none, tool, input))?.permissionDecision).toBe('deny')
  }
  expect(decision(await call(none, 'Bash', { command: `cat ${OWN}/x` }))?.permissionDecision).toBe(
    'deny',
  )
})

test('ownUploadsDir null still leaves ordinary repo work alone', async () => {
  const none = attachmentsHook(null)
  expect(await call(none, 'Read', { file_path: `${CWD}/src/index.ts` })).toEqual({})
  expect(await call(none, 'Bash', { command: 'bun test' })).toEqual({})
})

// --- fail closed --------------------------------------------------------------

test.each([
  ['Read', {}],
  ['Read', { file_path: 42 }],
  ['Read', { file_path: null }],
  ['Edit', undefined],
  ['Write', 'not-an-object'],
  ['NotebookRead', { notebook_path: ['x'] }],
  ['NotebookEdit', {}],
])('%s with a missing or non-string path is denied, not thrown', async (tool, input) => {
  expect(decision(await own(tool, input))?.permissionDecision).toBe('deny')
})

test.each([[{}], [{ command: 42 }], [null], ['string'], [{ command: undefined }]])(
  'Bash with tool_input %j carries no command string and is denied',
  async (input) => {
    expect(decision(await own('Bash', input))?.permissionDecision).toBe('deny')
  },
)

test('Grep/Glob with a non-string path fall back to cwd rather than failing closed', async () => {
  // Documented behaviour, not an oversight: those two tools genuinely default
  // to cwd, which is never under the storage root.
  expect(await own('Grep', { pattern: 'x', path: 42 })).toEqual({})
  expect(await own('Glob', { pattern: '**' })).toEqual({})
})

// --- the non-deny return is silence, for every silent branch ------------------

test('every non-deny return is exactly {} — never permissionDecision: allow', async () => {
  const silent = [
    await own('Read', { file_path: `${OWN}/error.log` }),
    await own('Grep', { pattern: 'x', path: OWN }),
    await own('Glob', { path: `${OWN}/*.log` }),
    await own('Edit', { file_path: `${OWN}/error.log` }),
    await own('Bash', { command: `cat ${OWN}/error.log` }),
    await own('Bash', { command: 'git status' }),
    await own('Read', { file_path: `${CWD}/src/index.ts` }),
    await own('WebFetch', { url: 'https://example.com' }),
    await own('Agent', { subagent_type: 'reviewer' }),
  ]
  for (const out of silent) {
    expect(out).toEqual({})
    expect(JSON.stringify(out)).not.toContain('allow')
  }
})

test('a non-PreToolUse event is never acted on', async () => {
  const hook = attachmentsHook(OWN).hooks[0]
  if (!hook) throw new Error('no callback')
  const out = await hook(
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: OTHER } } as never,
    'toolu_test',
    { signal: AbortSignal.timeout(1000) },
  )
  expect(out).toEqual({})
})

// --- the two PreToolUse matchers do not tread on each other -------------------

test('the matchers cover disjoint tool sets', () => {
  expect(delegationHook([]).matcher).toBe('Agent|Task')
  expect(attachmentsHook(OWN).matcher).toBe('Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit')
  const delegation = new Set(String(delegationHook([]).matcher).split('|'))
  const attachments = String(attachmentsHook(OWN).matcher).split('|')
  expect(attachments.filter((t) => delegation.has(t))).toEqual([])
})

test('delegationHook is unregressed: it still forces Agent into the foreground', async () => {
  const out = await call(delegationHook([]), 'Agent', { subagent_type: 'reviewer', prompt: 'go' })
  const d = decision(out) as { permissionDecision?: string; updatedInput?: Record<string, unknown> }
  expect(d?.permissionDecision).toBe('allow')
  expect(d?.updatedInput).toEqual({
    subagent_type: 'reviewer',
    prompt: 'go',
    run_in_background: false,
  })
})

test('delegationHook still refuses an agent off the roster', async () => {
  const roster = [{ name: 'agentoo:reviewer', description: 'r' }]
  const out = await call(delegationHook(roster), 'Task', { subagent_type: 'agentoo:intruder' })
  expect(decision(out)?.permissionDecision).toBe('deny')
  expect(String(decision(out)?.permissionDecisionReason)).toContain('roster')
})

test('delegationHook ignores the file tools attachmentsHook owns', async () => {
  expect(await call(delegationHook([]), 'Read', { file_path: `${OTHER}/x.log` })).toEqual({})
  expect(await call(delegationHook([]), 'Bash', { command: `cat ${OTHER}/x.log` })).toEqual({})
})

test('attachmentsHook ignores the delegation tools delegationHook owns', async () => {
  expect(await own('Agent', { subagent_type: 'reviewer', run_in_background: true })).toEqual({})
  expect(await own('Task', { subagent_type: 'reviewer' })).toEqual({})
})
