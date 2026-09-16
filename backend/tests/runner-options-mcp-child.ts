// Runs `optionsFor` for real and prints the facts as JSON. Child process
// because `mock.module` is process-global and bun shares the module registry
// across test files — the same reasoning session-claim-db.test.ts states.
//
// Only the modules that need a database or a live repo are faked. Everything
// this is actually testing — skillMcpServers, composeEnvFor, apiBaseUrl,
// projectPlugin, the option assembly in optionsFor itself — is the real code.

import { mock } from 'bun:test'

const PLUGIN_SKILLS = process.env.TEST_PLUGIN_SKILLS ?? ''

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

const { optionsFor } = await import('@/features/sessions/runner-options')

interface Case {
  label: string
  worktreePath: string | null
}

const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'

const cases: Case[] = [
  { label: 'worktree', worktreePath: '/tmp/agentoo-test-worktree' },
  { label: 'repo', worktreePath: null },
]

const facts: Record<string, unknown> = { pluginSkills: PLUGIN_SKILLS }

for (const c of cases) {
  const session = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    worktreePath: c.worktreePath,
    orchestrator: null,
    sdkSessionId: null,
    maxBudgetUsd: null,
    totalCostUsd: 0,
  } as unknown as Parameters<typeof optionsFor>[0]

  const options = await optionsFor(session, 'demo', new AbortController(), null)
  const env = (options.env ?? {}) as Record<string, string>
  facts[c.label] = {
    cwd: options.cwd,
    mcpServers: options.mcpServers ?? null,
    hasMcpServersKey: 'mcpServers' in options,
    strictMcpConfig: options.strictMcpConfig,
    plugins: options.plugins,
    agentooEnv: Object.fromEntries(
      Object.entries(env).filter(([k]) => k.startsWith('AGENTOO_')),
    ),
    hasSessionIdKey: 'AGENTOO_SESSION_ID' in env,
    // Proof the AGENTOO_* strip is not over-broad: an ordinary inherited
    // variable has to survive into the session untouched.
    unrelatedVar: env.UNRELATED_TEST_VAR ?? null,
  }
}

console.log(`__FACTS__${JSON.stringify(facts)}__FACTS__`)
