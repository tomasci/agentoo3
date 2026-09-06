// The tool-level layer over the attachments store — deny/allow/silence.
// Modeled on delegation-hook.test.ts's `call()` helper: invoke the matcher's
// one callback directly with a synthetic PreToolUse input.

import { expect, test } from 'bun:test'
import './setup-env'
import { env } from '../src/env'
import { attachmentsHook } from '../src/features/sessions/runner-options'

const ROOT = env.ATTACHMENTS_DIR
const OWN_UPLOADS = `${ROOT}/sessions/ab/12/ab120000-0000-0000-0000-000000000000/uploads`
const OTHER_UPLOADS = `${ROOT}/sessions/cd/34/cd340000-0000-0000-0000-000000000000/uploads`
const CWD = '/opt/agentoo/projects/demo/worktrees/sess-1'

const call = (ownUploadsDir: string | null, tool: string, input: unknown, cwd = CWD) => {
  const matcher = attachmentsHook(ownUploadsDir)
  const hook = matcher.hooks[0]
  if (!hook) throw new Error('attachmentsHook registered no callback')
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

const decision = (out: Awaited<ReturnType<typeof call>>) =>
  (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput

// --- silence: nothing under the attachments root at all ------------------

test('a Read of an ordinary repo path is silent, own dir or not', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Read', { file_path: `${CWD}/src/index.ts` }))).toBeUndefined()
  expect(decision(await call(null, 'Read', { file_path: `${CWD}/src/index.ts` }))).toBeUndefined()
})

test('Grep/Glob with no path defaults to cwd, which is never under the root', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Grep', { pattern: 'TODO' }))).toBeUndefined()
  expect(decision(await call(null, 'Glob', { pattern: '**/*.ts' }))).toBeUndefined()
})

test('a tool this hook does not guard is untouched', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Agent', { subagent_type: 'x' }))).toBeUndefined()
  expect(decision(await call(null, 'WebFetch', { url: 'https://example.com' }))).toBeUndefined()
})

// --- own uploads dir: allowed silently -------------------------------------

test('Read inside this session’s own uploads dir is silent', async () => {
  const out = await call(OWN_UPLOADS, 'Read', { file_path: `${OWN_UPLOADS}/error.log` })
  expect(decision(out)).toBeUndefined()
})

test('Grep/Glob given an explicit path inside the own dir is silent', async () => {
  expect(
    decision(await call(OWN_UPLOADS, 'Grep', { pattern: 'x', path: OWN_UPLOADS })),
  ).toBeUndefined()
  expect(decision(await call(OWN_UPLOADS, 'Glob', { path: `${OWN_UPLOADS}/*.pdf` }))).toBeUndefined()
})

test('NotebookRead/NotebookEdit resolve notebook_path the same way', async () => {
  expect(
    decision(
      await call(OWN_UPLOADS, 'NotebookRead', { notebook_path: `${OWN_UPLOADS}/data.ipynb` }),
    ),
  ).toBeUndefined()
})

// --- denied: under the root, but not this session's own directory --------

test('Read of another session’s uploads dir is denied', async () => {
  const out = decision(
    await call(OWN_UPLOADS, 'Read', { file_path: `${OTHER_UPLOADS}/secret.log` }),
  )
  expect(out?.permissionDecision).toBe('deny')
  expect(String(out?.permissionDecisionReason)).toContain('outside this session')
})

test('Edit and Write reach the same own-dir-vs-other logic as every guarded tool', async () => {
  // This hook applies one rule to every guarded tool, Edit/Write included:
  // deny under the root and outside ownUploadsDir, silence otherwise. It is
  // `Options.settings.permissions.deny` (optionsFor, unconditional on Edit and
  // Write for the whole root) that actually stops an agent mutating its own
  // uploads — this layer's own-dir case is deliberately silent here, and
  // still denies the other-session case exactly like Read does.
  expect(
    decision(await call(OWN_UPLOADS, 'Edit', { file_path: `${OWN_UPLOADS}/error.log` })),
  ).toBeUndefined()
  expect(
    decision(await call(OWN_UPLOADS, 'Write', { file_path: `${OTHER_UPLOADS}/error.log` }))
      ?.permissionDecision,
  ).toBe('deny')
})

test('a session with no attachments (ownUploadsDir null) denies everything under the root', async () => {
  const out = decision(await call(null, 'Read', { file_path: `${OWN_UPLOADS}/error.log` }))
  expect(out?.permissionDecision).toBe('deny')
})

// --- Bash: substring reasoning over the whole command ----------------------

test('a Bash command that never mentions the root is silent', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Bash', { command: 'ls -la && git status' }))).toBeUndefined()
})

test('a Bash command touching only the session’s own uploads dir is silent', async () => {
  const out = await call(OWN_UPLOADS, 'Bash', { command: `cat ${OWN_UPLOADS}/error.log` })
  expect(decision(out)).toBeUndefined()
})

test('a Bash command reaching another session’s directory is denied', async () => {
  const out = decision(await call(OWN_UPLOADS, 'Bash', { command: `cat ${OTHER_UPLOADS}/x.log` }))
  expect(out?.permissionDecision).toBe('deny')
})

test('a Bash command mixing the own dir and something else under the root is denied', async () => {
  const command = `cat ${OWN_UPLOADS}/error.log; cat ${ROOT}/sessions/aa/bb/other/uploads/y.log`
  expect(decision(await call(OWN_UPLOADS, 'Bash', { command }))?.permissionDecision).toBe('deny')
})

test('Bash with no attachments at all denies any command mentioning the root', async () => {
  const out = decision(await call(null, 'Bash', { command: `cat ${ROOT}/sessions/aa/bb/x/uploads/y` }))
  expect(out?.permissionDecision).toBe('deny')
})

// --- fail closed -------------------------------------------------------------

test('a Read with no file_path is denied rather than silently allowed', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Read', {}))?.permissionDecision).toBe('deny')
})

test('a malformed tool_input on a guarded tool is denied, not thrown', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Write', null))?.permissionDecision).toBe('deny')
})

test('a Bash call with no command string is denied', async () => {
  expect(decision(await call(OWN_UPLOADS, 'Bash', { foo: 'bar' }))?.permissionDecision).toBe('deny')
})

// --- non-deny is always silence, never an explicit allow --------------------

test('the non-deny return is always {} and never permissionDecision: allow', async () => {
  const out = await call(OWN_UPLOADS, 'Read', { file_path: `${OWN_UPLOADS}/error.log` })
  expect(out).toEqual({})
})
