import { join } from 'node:path'
import type { HookCallback, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import type { sessions } from '@/db/schema'
import { syncProjectPlugin } from '@/features/library/service'
import { keyPathFor } from '@/features/ssh-keys/service'
import { configureRepoSsh, isGitRepo } from '@/lib/git'
import { logger } from '@/lib/logger'
import { projectPlugin, projectRepo } from '@/lib/paths'
import { gitSshCommand, keyProblem } from '@/lib/ssh'
import { getAgent, listAgents, subagents } from '@/library/index'
import {
  composeOrchestratorPrompt,
  delegationEnv,
  type Specialist,
} from '@/library/orchestrator-prompt'
import { PLUGIN_NAME } from '@/queue/plugin-manifest'

/** Deterministic ceiling on delegation, paired with the prompt-level guidance. */
const MAX_SPAWN_DEPTH = 2
const MAX_CONCURRENT_SUBAGENTS = 3

/** The delegation tools across SDK versions. Same predicate as titles.ts's `isSpawn`. */
const isDelegationTool = (name: string) => name === 'Agent' || name === 'Task'

/**
 * Force delegation into the foreground, and restrict it to this project's
 * roster — both by a `PreToolUse` hook rather than by asking.
 *
 * The Agent tool defaults `run_in_background` to true. A per-turn process has
 * nowhere to host a task left running that way: the SDK closes the query
 * stream and the CLI child process exits the moment the orchestrator's turn
 * ends, SIGKILLing anything still backgrounded — which is what produced the
 * "another crash" reports this fix responds to, none of which were crashes.
 * `updatedInput` flips the flag before the tool runs; fan-out is unaffected,
 * several `Agent` calls in one assistant message still run concurrently, only
 * the turn now blocks until they are all done. `session-run.worker.ts` carries
 * a safety net for the case a task somehow still outlives the turn regardless.
 *
 * The roster check is the same argument applied to who may be addressed:
 * `rosterInstruction` tells the model the team, but prompting only steers (see
 * `delegationEnv` in orchestrator-prompt.ts), so a call naming anything off the
 * roster is denied here, from the same `specialists` list the prompt was built
 * from — one list, so the prompt, the plugin directory and this enforcement
 * cannot disagree. An empty roster (no specialists assigned, or a solo agent)
 * leaves delegation unrestricted, matching what `rosterInstruction` tells the
 * model to do in that case: fall back to the harness's own generic agents.
 */
export function delegationHook(specialists: Specialist[]): HookCallbackMatcher {
  const roster = new Set(specialists.map((s) => s.name))
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !isDelegationTool(input.tool_name)) return {}

    const toolInput =
      input.tool_input && typeof input.tool_input === 'object'
        ? { ...(input.tool_input as Record<string, unknown>) }
        : {}
    const subagentType =
      typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : undefined

    if (roster.size > 0 && subagentType && !roster.has(subagentType)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `"${subagentType}" is not on this project's roster. Address one of: ${[...roster].join(', ')}.`,
        },
      }
    }

    if (toolInput.run_in_background === false) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, run_in_background: false },
      },
    }
  }
  return { matcher: 'Agent|Task', hooks: [hook] }
}

/**
 * Build the SDK options for this session.
 *
 * The orchestrator's markdown body becomes the system prompt, composed between
 * the library's shared orchestration method and the delegation, roster and
 * autonomy guarantees. Its subagents reach the session through the project's
 * plugin directory, which is the same set the library page assigns, so what runs
 * matches what the UI shows — and the roster in the prompt is read back out of
 * that directory rather than assembled separately, so the team the orchestrator
 * is told about is exactly the team the SDK loads.
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

  // Read from the plugin copy, not the library: this is the set that will load,
  // already narrowed to this project's assignment. Orchestrators in it are
  // skipped — `role` says who may drive a session and who may be delegated to,
  // and offering the lead a copy of itself as a specialist invites a loop the
  // spawn-depth cap would have to catch.
  const specialists: Specialist[] = orchestrator?.team
    ? subagents(await listAgents(join(pluginRoot, 'agents'))).map((a) => ({
        name: `${PLUGIN_NAME}:${a.name}`,
        description: a.description,
      }))
    : []

  // The cap covers the session, not the turn, so what is already spent has to
  // come off it — otherwise a $20 ceiling permits $20 per turn indefinitely.
  // Clamped at zero rather than skipped when overspent: a session past its
  // budget should stop at the SDK with `error_max_budget_usd`, which the worker
  // reports, instead of silently running one more turn for free.
  const budget =
    session.maxBudgetUsd === null
      ? undefined
      : Math.max(session.maxBudgetUsd - session.totalCostUsd, 0)

  return {
    cwd,
    abortController,
    plugins: [{ type: 'local', path: pluginRoot }],
    // 'project' is what loads the repo's own CLAUDE.md, which is usually the
    // most useful context a project has.
    settingSources: ['project'],
    ...(orchestrator && {
      systemPrompt: await composeOrchestratorPrompt(
        orchestrator.prompt,
        orchestrator.team,
        specialists,
      ),
    }),
    ...(orchestrator?.model && { model: orchestrator.model }),
    // The rest of the orchestrator's frontmatter, which used to be parsed and
    // then dropped on the floor: the library UI offered `effort`, `maxTurns`,
    // `tools` and `disallowedTools`, and none of them reached the SDK, so the
    // shipped orchestrator ran at default effort with full write access while
    // its own file said `effort: xhigh` and `disallowedTools: [Edit, Write,
    // NotebookEdit]`. `tools` is the option that narrows what exists;
    // `allowedTools` only auto-approves, which under bypassPermissions would
    // mean nothing.
    ...(orchestrator?.effort && { effort: orchestrator.effort }),
    ...(orchestrator?.maxTurns && { maxTurns: orchestrator.maxTurns }),
    ...(orchestrator?.tools && { tools: orchestrator.tools }),
    ...(orchestrator?.disallowedTools && { disallowedTools: orchestrator.disallowedTools }),
    // Enforced rather than asked for: forces delegation into the foreground so
    // a subagent cannot outlive the turn that spawned it, and refuses agents
    // outside this project's roster.
    hooks: { PreToolUse: [delegationHook(specialists)] },
    ...(budget !== undefined && { maxBudgetUsd: budget }),
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
