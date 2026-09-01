import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { sessions } from '@/db/schema'
import { syncProjectPlugin } from '@/features/library/service'
import { projectPlugin, projectRepo } from '@/lib/paths'
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
): Promise<Options> {
  const cwd = session.worktreePath ?? projectRepo(slug)
  // Rebuilt now rather than trusted: the plugin directory is a copy of the
  // library, so an agent edited centrally since the last run only reaches this
  // project here. It also repairs anything that drifted.
  await syncProjectPlugin(slug, session.projectId)
  const pluginRoot = projectPlugin(slug)

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
    },
  }
}
