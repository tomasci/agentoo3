import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { sessions } from '@/db/schema'
import { syncProjectPlugin } from '@/features/library/service'
import { keyPathFor } from '@/features/ssh-keys/service'
import { configureRepoSsh, isGitRepo } from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectPlugin, projectRepo } from '@/lib/paths'
import { gitSshCommand, keyProblem } from '@/lib/ssh'
import { delegationEnv, withDelegationGuidance } from '@/library/delegation'
import { getAgent } from '@/library/index'

/** Deterministic ceiling on delegation, paired with the prompt-level guidance. */
const MAX_SPAWN_DEPTH = 2
const MAX_CONCURRENT_SUBAGENTS = 3

/**
 * Build the SDK options for this session.
 *
 * The orchestrator's markdown body becomes the system prompt, with the
 * delegation guidance appended. Its subagents are not listed here: they reach
 * the session through the project's plugin directory, which is the same set the
 * library page assigns, so what runs matches what the UI shows.
 */
export async function optionsFor(
  session: typeof sessions.$inferSelect,
  slug: string,
  abortController: AbortController,
  sshKeyId: string | null = null,
): Promise<Options> {
  const cwd = session.worktreePath ?? projectRepo(slug)
  // Rebuilt now rather than trusted: the plugin directory is a copy of the
  // library, so an agent edited centrally since the last run only reaches this
  // project here. It also repairs anything that drifted.
  await syncProjectPlugin(slug, session.projectId)
  const pluginRoot = projectPlugin(slug)

  // Also reconciled here, not only after a clone, so projects created before
  // this existed pick it up on their next run rather than needing a repair
  // step. Without it the agent's own `git fetch` has no key and fails with
  // "Host key verification failed".
  const repo = projectRepo(slug)
  const keyPath = await keyPathFor(sshKeyId)
  if (keyPath) {
    // Logged, not fatal: plenty of sessions never touch the remote, and
    // refusing to start one because a fetch would fail is worse than letting it
    // run. The warning is what makes the later failure legible.
    const problem = await keyProblem(keyPath)
    if (problem) logger.warn(`Session ${session.id} ssh key unusable — ${problem}`)
  }
  if (await isGitRepo(repo)) {
    const configured = await configureRepoSsh(repo, keyPath ? gitSshCommand(keyPath) : undefined)
    if (!configured.ok) {
      logger.warn(`Could not set core.sshCommand for ${slug}: ${configured.stderr}`)
    }
  }

  const orchestrator = session.orchestrator ? await getAgent(session.orchestrator) : undefined
  if (session.orchestrator && !orchestrator) {
    throw new Error(`Orchestrator "${session.orchestrator}" is not in the library any more`)
  }
  if (orchestrator && orchestrator.role !== 'orchestrator') {
    throw new Error(`Agent "${orchestrator.name}" is a subagent and cannot drive a session`)
  }

  return {
    cwd,
    abortController,
    plugins: [{ type: 'local', path: pluginRoot }],
    // 'project' is what loads the repo's own CLAUDE.md, which is usually the
    // most useful context a project has.
    settingSources: ['project'],
    ...(orchestrator && { systemPrompt: withDelegationGuidance(orchestrator.prompt) }),
    ...(orchestrator?.model && { model: orchestrator.model }),
    // Full tool access, deliberately: this runs on a single-user box behind a
    // tailnet, and prompting for permission has nobody to ask.
    permissionMode: 'bypassPermissions',
    // The whole point of the transcript: without this only tool_use blocks come
    // back from subagents, and the delegated work is invisible.
    forwardSubagentText: true,
    ...(session.sdkSessionId && { resume: session.sdkSessionId }),
    env: {
      ...process.env,
      ...delegationEnv(MAX_SPAWN_DEPTH, MAX_CONCURRENT_SUBAGENTS),
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentoo/1.0.0',
      // Belt and braces alongside core.sshCommand: this also covers a remote
      // added during the session, and any bare `ssh` the agent runs.
      ...(keyPath ? { GIT_SSH_COMMAND: gitSshCommand(keyPath) } : {}),
    },
  }
}
