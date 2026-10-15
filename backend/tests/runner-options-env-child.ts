// Runs the real `optionsFor` under a process.env carrying every credential
// canary (runner-options-env.test.ts sets them) and prints what reached
// `Options.env` — the environment a session's CLI process, and every Bash
// command its agent runs, actually gets.
//
// A child process for the same reason runner-options-mcp-child.ts is one:
// `mock.module` is process-global. The same four modules are faked, for the
// same reason — each needs a database or a live checkout — and nothing else.

import { mock } from 'bun:test'
import { CLAUDE_CREDENTIALS, leakedCanaries, REQUIRED_SCRUBBED } from './app-credentials'

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
  sessionAttachmentsSummary: async () => null,
}))

// Checked before anything else, so a passing test cannot be the product of a
// parent that forgot to set the canaries: every one of them has to be in this
// process's own env for "none of them reached the session" to mean anything.
const missing = REQUIRED_SCRUBBED.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`canaries missing from the child's own env: ${missing.join(', ')}`)
  process.exit(2)
}

const { optionsFor } = await import('@/features/sessions/runner-options')
const { APP_CREDENTIAL_VARS } = await import('@/lib/child-env')

const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const PROJECT_ID = '66666666-6666-4666-8666-666666666666'

const facts: Record<string, unknown> = {}

for (const [label, worktreePath] of [
  ['worktree', '/tmp/agentoo-test-env-worktree'],
  ['repo', null],
] as const) {
  const session = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    worktreePath,
    orchestrator: null,
    sdkSessionId: null,
    maxBudgetUsd: null,
    totalCostUsd: 0,
  } as unknown as Parameters<typeof optionsFor>[0]

  const options = await optionsFor(session, 'demo', new AbortController(), null)
  const env = (options.env ?? {}) as Record<string, string | undefined>
  facts[label] = {
    // Names only, never the whole env: the parent's ambient variables ride
    // along here too, and a failure message has no business printing them.
    keys: Object.keys(env),
    present: [...REQUIRED_SCRUBBED, ...APP_CREDENTIAL_VARS].filter((key) => key in env),
    leaked: leakedCanaries(env),
    claude: Object.fromEntries(Object.keys(CLAUDE_CREDENTIALS).map((key) => [key, env[key]])),
    agentooEnv: Object.fromEntries(
      Object.entries(env).filter(([key]) => key.startsWith('AGENTOO_')),
    ),
    unrelatedVar: env.UNRELATED_TEST_VAR ?? null,
    hasPath: typeof env.PATH === 'string' && env.PATH.length > 0,
  }
}

console.log(`__FACTS__${JSON.stringify(facts)}__FACTS__`)
process.exit(0)
