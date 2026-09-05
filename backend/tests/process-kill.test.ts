// Regression cover for the failure that reads as a crash and is not one.
//
// Every string here is verbatim from the Agent SDK, or from the export of the
// session that produced this: four turns in one hour, each ending "Turn failed:
// Claude Code process exited with code 143", each needing its operator to
// notice and type "Continue". Nothing had crashed. A `bun test` run had
// exhausted a 4GB box, the kernel OOM-killed it, and systemd — whose
// `OOMPolicy` defaults to `stop` — terminated the whole worker unit in
// response, taking the running `claude` with it.

import { expect, test } from 'bun:test'
import { processKill } from '../src/queue/session-run.worker'

// --- what the incident actually looked like ----------------------------------

test('the message four turns died with is read as a SIGTERM', () => {
  // Copied out of the session export, exactly as it was shown to the operator.
  expect(processKill('Claude Code process exited with code 143')?.signal).toBe('SIGTERM')
})

test('a stderr tail does not stop the code being found', () => {
  // The SDK appends up to 2KB of the child's stderr to the same message.
  const detail =
    'Claude Code process exited with code 143. stderr: Bun v1.3.9 (Linux x64)\npanic: out of memory'
  expect(processKill(detail)?.signal).toBe('SIGTERM')
})

test('the OOM killer taking the CLI itself is read as a SIGKILL', () => {
  expect(processKill('Claude Code process exited with code 137')?.signal).toBe('SIGKILL')
})

test("the SDK's other wording — a signal it saw directly — is read too", () => {
  // Reported when the kernel stops the process before its own handler runs, so
  // there is no 128+n exit code to decode.
  expect(processKill('Claude Code process terminated by signal SIGKILL')?.signal).toBe('SIGKILL')
  expect(processKill('Claude Code process terminated by signal SIGTERM')?.signal).toBe('SIGTERM')
})

test('a kill the SDK reports second-hand is still a kill', () => {
  // What comes back when the query tries to write to a process that has already
  // gone: the original exit error, quoted inside a new one. Anchoring the match
  // to the start of the message would miss exactly this.
  expect(
    processKill(
      'Cannot write to process that exited with error: Claude Code process exited with code 143',
    )?.signal,
  ).toBe('SIGTERM')
})

test('a hangup or an interrupt is external too', () => {
  expect(processKill('Claude Code process exited with code 129')?.signal).toBe('SIGHUP')
  expect(processKill('Claude Code process exited with code 130')?.signal).toBe('SIGINT')
})

// --- what an operator is told -------------------------------------------------

test('a kill is explained in terms of the thing that caused it', () => {
  // The number on its own is what the operator was left with, and it told them
  // nothing. These two sentences are the fix, so they are asserted rather than
  // left to drift back into "exited with code 143".
  expect(processKill('Claude Code process exited with code 137')?.cause).toContain(
    'out-of-memory killer',
  )
  expect(processKill('Claude Code process exited with code 143')?.cause).toContain('systemd')
  expect(processKill('Claude Code process exited with code 129')?.cause).toBeTruthy()
})

// --- what must keep failing ---------------------------------------------------

test('a process that killed itself is a crash, and crashes are not retried', () => {
  // SIGSEGV, SIGABRT (which is what a fatal heap OOM inside the CLI produces),
  // SIGILL, SIGBUS, SIGFPE. Every one of them is deterministic on this
  // conversation: resuming buys three more identical crashes at full model
  // cost. Only a kill imposed from outside is worth picking back up.
  for (const code of [132, 134, 135, 136, 139]) {
    expect(processKill(`Claude Code process exited with code ${code}`)).toBeUndefined()
  }
  expect(processKill('Claude Code process terminated by signal SIGSEGV')).toBeUndefined()
  expect(processKill('Claude Code process terminated by signal SIGABRT')).toBeUndefined()
})

test('an ordinary non-zero exit is a failure, not a kill', () => {
  // Resuming these would re-run a turn that fails again the same way, and bill
  // for it. 128 is 128 + 0, which is no signal at all.
  for (const code of [0, 1, 2, 3, 64, 128, 143 + 128, 160, 255]) {
    expect(processKill(`Claude Code process exited with code ${code}`)).toBeUndefined()
  }
})

test('the failures that are nothing to do with a kill are left alone', () => {
  const notKills = [
    'Failed to spawn Claude Code process: EACCES',
    'Claude Code executable not found at /usr/local/bin/claude. Is options.pathToClaudeCodeExecutable set?',
    'Claude Code returned an error result: rate limit exceeded',
    'No Claude credential. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.',
    'Orchestrator "scout" is not in the library any more',
    'Session 9f2 disappeared mid-turn',
    '',
  ]
  for (const detail of notKills) expect(processKill(detail)).toBeUndefined()
})

test('a number that merely looks like an exit code is not one', () => {
  // The stderr tail is arbitrary text from whatever the agent ran, and it lands
  // in the same string. Only the SDK's own wording may be read as a kill.
  expect(
    processKill('Claude Code returned an error result: the build exited with code 143'),
  ).toBeUndefined()
  expect(processKill('exit code 143')).toBeUndefined()
})

test('a real exit code is not overridden by a signal quoted in the stderr after it', () => {
  // Both wordings in one string, which the stderr tail makes possible: the
  // agent's own command may print either. The SDK writes its verdict first, so
  // the first one is the real one — reading the later match instead would turn
  // a genuine exit 1 into three billed retries.
  expect(
    processKill(
      'Claude Code process exited with code 1. stderr: bun test\nClaude Code process terminated by signal SIGKILL',
    ),
  ).toBeUndefined()
  // And the other way round: the signal came first, so it is the verdict.
  expect(
    processKill(
      'Claude Code process terminated by signal SIGKILL. stderr: the child said Claude Code process exited with code 1',
    )?.signal,
  ).toBe('SIGKILL')
})
