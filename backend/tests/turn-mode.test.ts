// Q&A mode's pure parts: which mode a stored payload means, what prompt a mode
// produces, what the request body accepts, and what the read-only hook refuses.
//
// What reaches the SDK and the database is covered where those are already
// faked: runner-options-turn-mode.test.ts (optionsFor, through a child
// process), session-recovery.test.ts (the worker and its continuations) and
// session-message-shape.test.ts (what sendMessage stores).

import { expect, test } from 'bun:test'
import './setup-env'
import { qaReadOnlyHook } from '../src/features/sessions/runner-options'
import { sendMessageSchema, turnModeSchema } from '../src/features/sessions/schema'
import {
  composeTurnPrompt,
  QA_MODE_INSTRUCTION,
  turnModeOf,
} from '../src/features/sessions/turn-mode'

// --- turnModeOf ---------------------------------------------------------------

test("only an explicit mode: 'qa' is Q&A", () => {
  expect(turnModeOf({ text: 'why?', mode: 'qa' })).toBe('qa')
  expect(turnModeOf({ text: 'why?', auto: true, mode: 'qa' })).toBe('qa')
})

test('a Code payload, with the key or without it, is Code', () => {
  expect(turnModeOf({ text: 'do it' })).toBe('code')
  expect(turnModeOf({ text: 'do it', mode: 'code' })).toBe('code')
  expect(turnModeOf({ text: 'do it', auto: true })).toBe('code')
})

test('anything that is not a payload with mode qa falls back to Code, never throws', () => {
  // A payload is JSON read back from the database. The permissive default is
  // what every row from before modes existed gets, so it is also what garbage
  // gets — a turn must not fail to start over a malformed one.
  for (const garbage of [
    undefined,
    null,
    'qa',
    42,
    true,
    [],
    ['qa'],
    {},
    { mode: null },
    { mode: 'QA' },
    { mode: 'Q&A' },
    { mode: ['qa'] },
    { mode: { qa: true } },
    { text: 'qa' },
  ]) {
    expect(turnModeOf(garbage)).toBe('code')
  }
})

// --- composeTurnPrompt --------------------------------------------------------

/** What the worker built inline before modes existed, kept here to compare against. */
const codePromptBefore = (announcement: string, text: string) =>
  announcement ? `${announcement}\n${text}` : text

test('Code is byte-identical to the prompt the worker always built', () => {
  const announcement = 'Files attached to this message:\n- /tmp/a.png'
  for (const text of ['fix the bug', '', ' leading space\nand a second line ', 'ünïcode ✓']) {
    for (const ann of [announcement, '']) {
      expect(composeTurnPrompt({ announcement: ann, text, mode: 'code' })).toBe(
        codePromptBefore(ann, text),
      )
    }
  }
})

test('Q&A without an announcement is the instruction, a blank line, then the message', () => {
  expect(composeTurnPrompt({ announcement: '', text: 'what does this do?', mode: 'qa' })).toBe(
    `${QA_MODE_INSTRUCTION}\n\nwhat does this do?`,
  )
})

test('Q&A with an announcement orders announcement, instruction, message — user text intact', () => {
  const announcement = 'Files attached to this message:\n- /tmp/a.png'
  const text = '  what is in the screenshot?\n\nAnd how does it relate to the bug?  '
  const prompt = composeTurnPrompt({ announcement, text, mode: 'qa' })

  expect(prompt).toBe(`${announcement}\n${QA_MODE_INSTRUCTION}\n\n${text}`)
  expect(prompt.indexOf(announcement)).toBeLessThan(prompt.indexOf(QA_MODE_INSTRUCTION))
  expect(prompt.indexOf(QA_MODE_INSTRUCTION)).toBeLessThan(prompt.lastIndexOf(text))
  expect(prompt.endsWith(text)).toBe(true)
})

test('the Code prompt never carries the Q&A instruction', () => {
  expect(composeTurnPrompt({ announcement: 'note', text: 'go', mode: 'code' })).not.toContain(
    '[Q&A mode]',
  )
})

test('the instruction is the agreed text, word for word', () => {
  // Pinned verbatim: it is a prompt other people read and tune, and a silent
  // reword is a behaviour change nothing else would catch.
  expect(QA_MODE_INSTRUCTION).toBe(
    "[Q&A mode] The user's message below is a question or a note, not a task. Answer it conversationally, using everything already in this conversation. Do not edit, create, or delete files, do not run commands that change state (no commits, installs, migrations, builds that write files, or service/container changes), do not delegate work that would make changes, and do not make any other modifications. You may read files and inspect the project to answer accurately. This applies to this message only.",
  )
})

// --- the request body ---------------------------------------------------------

test('a body with only text is still valid, and means Code', () => {
  // Every client written before the field existed sends exactly this.
  expect(sendMessageSchema.parse({ text: 'hello' })).toEqual({ text: 'hello', mode: 'code' })
})

test("mode 'code' and 'qa' are accepted as sent", () => {
  expect(sendMessageSchema.parse({ text: 'hello', mode: 'code' }).mode).toBe('code')
  expect(sendMessageSchema.parse({ text: 'hello', mode: 'qa' }).mode).toBe('qa')
})

test('any other mode is rejected at the boundary', () => {
  for (const mode of ['plan', 'QA', 'Q&A', '', null, 1, true, ['qa'], {}]) {
    expect(sendMessageSchema.safeParse({ text: 'hello', mode }).success).toBe(false)
  }
})

test('text is still required, and still bounded, whatever the mode', () => {
  expect(sendMessageSchema.safeParse({ mode: 'qa' }).success).toBe(false)
  expect(sendMessageSchema.safeParse({ text: '', mode: 'qa' }).success).toBe(false)
  expect(sendMessageSchema.safeParse({ text: 'x'.repeat(100_001), mode: 'qa' }).success).toBe(false)
})

test('turnModeSchema is exactly the two modes', () => {
  expect(turnModeSchema.options).toEqual(['code', 'qa'])
})

// --- qaReadOnlyHook -----------------------------------------------------------

/** Run the matcher's hook the way the SDK would, on an arbitrary hook event. */
const fire = (event: string, tool: string, input: unknown = {}) => {
  const hook = qaReadOnlyHook().hooks[0]
  if (!hook) throw new Error('qaReadOnlyHook registered no callback')
  return hook(
    {
      hook_event_name: event,
      tool_name: tool,
      tool_input: input,
      tool_use_id: 'toolu_test',
    } as never,
    'toolu_test',
    { signal: AbortSignal.timeout(1000) },
  )
}

const decision = (out: Awaited<ReturnType<typeof fire>>) =>
  (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput

test('every direct file-writing tool is denied, with a reason the model can act on', async () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const out = decision(await fire('PreToolUse', tool, { file_path: '/work/a.ts' }))
    expect(out?.hookEventName).toBe('PreToolUse')
    expect(out?.permissionDecision).toBe('deny')
    expect(String(out?.permissionDecisionReason)).toContain('Q&A mode')
    expect(String(out?.permissionDecisionReason)).toContain('Answer')
  }
})

test('it never approves: reading tools and Bash get silence, not an allow', async () => {
  // An 'allow' from here would approve the very call another layer might have
  // refused. Bash is deliberately not this hook's to judge.
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'Agent', 'Task', 'TodoWrite']) {
    expect(await fire('PreToolUse', tool, { command: 'git log' })).toEqual({})
  }
})

test('it is silent for every event that is not a PreToolUse', async () => {
  for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'Notification']) {
    expect(await fire(event, 'Edit', { file_path: '/work/a.ts' })).toEqual({})
  }
})

test('the matcher names exactly the tools the hook refuses', () => {
  const { matcher } = qaReadOnlyHook()
  expect(matcher?.split('|').sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write'])
})
