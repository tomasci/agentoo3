// Runs the real `optionsFor` once per (attachments, mode) and prints what came
// back, for runner-options-turn-mode.test.ts.
//
// A child process for the same reason runner-options-mcp-child.ts is one:
// `mock.module` is process-global, and the same four modules are faked here —
// each needs a database or a live checkout — and nothing else. The session has a
// real orchestrator (a file in the child's own LIBRARY_DIR, written by the
// parent), because `tools`, `disallowedTools`, `systemPrompt`, `model` and
// `effort` only exist on the options when one does, and "Q&A leaves those alone"
// is the claim under test.

import { mock } from 'bun:test'

let attachmentsOn = false

mock.module('@/features/library/service', () => ({
  syncProjectPlugin: async () => {},
}))
mock.module('@/features/ssh-keys/service', () => ({
  keyPathFor: async () => null,
}))
mock.module('@/lib/git', () => ({
  isGitRepo: async () => false,
  configureRepoSsh: async () => ({ ok: true, stderr: '' }),
}))
mock.module('@/features/attachments/service', () => ({
  sessionAttachmentsSummary: async () =>
    attachmentsOn
      ? {
          uploadsDir: `${process.env.ATTACHMENTS_DIR}/ab/cd/own-session/uploads`,
          fileCount: 2,
          manifestPath: `${process.env.ATTACHMENTS_DIR}/ab/cd/own-session/ATTACHMENTS.md`,
        }
      : null,
}))

const { optionsFor } = await import('@/features/sessions/runner-options')

const SESSION_ID = '77777777-7777-4777-8777-777777777777'
const PROJECT_ID = '88888888-8888-4888-8888-888888888888'

const session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  worktreePath: '/tmp/agentoo-test-turn-mode-worktree',
  orchestrator: 'lead',
  // Set, so `resume` is on the options: a Q&A turn has to continue the same
  // conversation, which is the whole reason for it living in the same session.
  sdkSessionId: 'sdk-session-under-test',
  maxBudgetUsd: 20,
  totalCostUsd: 5,
} as unknown as Parameters<typeof optionsFor>[0]

type Hooks = NonNullable<Awaited<ReturnType<typeof optionsFor>>['hooks']>

const facts: Record<string, unknown> = {}

for (const attachments of [false, true]) {
  attachmentsOn = attachments
  for (const mode of ['code', 'qa'] as const) {
    const options = await optionsFor(session, 'demo', new AbortController(), null, mode)

    // Hooks are functions and do not survive JSON, so they are reduced to what
    // can be compared — their matchers — and the one this feature adds is
    // actually fired, to prove what is registered is the real thing.
    const preToolUse = (options.hooks as Hooks).PreToolUse ?? []
    const qa = preToolUse.find((m) => m.matcher === 'Edit|Write|MultiEdit|NotebookEdit')
    const verdict = qa
      ? await qa.hooks[0]?.(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path: '/tmp/x' },
            tool_use_id: 'toolu_test',
          } as never,
          'toolu_test',
          { signal: AbortSignal.timeout(1000) },
        )
      : null

    const { abortController: _abort, hooks: _hooks, ...rest } = options
    facts[`${attachments ? 'attachments' : 'none'}:${mode}`] = {
      options: { ...rest, hooks: { PreToolUse: preToolUse.map((m) => m.matcher) } },
      keys: Object.keys(options).sort(),
      qaHookVerdict: verdict,
    }
  }
}

// Order matters for a leak: the loop above always builds Code before Q&A. Here
// Q&A goes first and Code follows in the same process, and the first Q&A
// result is mutated before the second Q&A is built, so module-level state
// shared between calls (an allow list or hook array handed out by reference)
// would show up as a difference.
{
  attachmentsOn = false
  const reduce = (options: Awaited<ReturnType<typeof optionsFor>>) => {
    const { abortController: _abort, hooks, ...rest } = options
    return {
      options: {
        ...rest,
        hooks: { PreToolUse: ((hooks as Hooks).PreToolUse ?? []).map((m) => m.matcher) },
      },
      keys: Object.keys(options).sort(),
      qaHookVerdict: null,
    }
  }
  const firstQa = await optionsFor(session, 'demo', new AbortController(), null, 'qa')
  const codeAfter = await optionsFor(session, 'demo', new AbortController(), null, 'code')
  firstQa.allowedTools?.push('Edit', 'Write', 'Bash')
  ;(firstQa.hooks as Hooks).PreToolUse?.splice(0)
  const secondQa = await optionsFor(session, 'demo', new AbortController(), null, 'qa')
  facts['sequence:code-after-qa'] = reduce(codeAfter)
  facts['sequence:qa-after-mutation'] = reduce(secondQa)
}

console.log(`__FACTS__${JSON.stringify(facts)}__FACTS__`)
process.exit(0)
