import { join, resolve, sep } from 'node:path'
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'
import type { sessions } from '@/db/schema'
import { env } from '@/env'
import { attachmentsSystemPromptBlock } from '@/features/attachments/manifest'
import { sessionAttachmentsSummary } from '@/features/attachments/service'
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

/** Tools attachmentsHook inspects. Grep/Glob without an explicit path search
 * `cwd`, which is never under the attachments root, so they fall through to
 * silence on their own — this list exists to bound the guard to tools that
 * can name an arbitrary filesystem path or command at all. */
const ATTACHMENT_GUARDED_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'NotebookRead',
  'NotebookEdit',
])

function denyOutsideOwn(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/** The path a tool call would touch, per its own input shape. `'.'` — never
 * under the attachments root — is the honest default for Grep/Glob with no
 * `path` given, matching how those tools actually resolve one. `undefined`
 * means "fail closed": Read/Edit/Write/NotebookRead/NotebookEdit always carry
 * a path in a well-formed call, so one that does not is denied rather than
 * silently let through. */
function pathInputFor(name: string, toolInput: unknown): string | undefined {
  const input =
    toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : undefined
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return typeof input?.file_path === 'string' ? input.file_path : undefined
    case 'NotebookRead':
    case 'NotebookEdit':
      return typeof input?.notebook_path === 'string' ? input.notebook_path : undefined
    case 'Grep':
    case 'Glob':
      return typeof input?.path === 'string' ? input.path : '.'
    default:
      return undefined
  }
}

/** True when `path` is `dir` itself or reaches somewhere inside it. Shared by
 * both branches below — the Bash-command scanner and the direct-path-input
 * check further down — so "is this inside `dir`" has exactly one definition
 * and the two branches cannot silently drift apart on what containment means. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep)
}

/** Shell metacharacters and whitespace that end a path argument. Not a shell
 * parser — just enough to isolate one path token from whatever comes after
 * it in the command string. */
const BASH_PATH_TOKEN_STOP = /[\s"';|&()<>]/

/**
 * True when every literal appearance of `root` in `command` resolves — after
 * `path.resolve()` collapses any `..` — to somewhere inside `ownUploadsDir`.
 *
 * `root` is itself an absolute path, so an occurrence of it in the command
 * always *starts* a path token rather than sitting mid-word; scanning forward
 * from that index to the next whitespace or shell metacharacter is what turns
 * "<OWN>/../../../../cd/34/<id>/uploads/x" into one string to resolve, rather
 * than comparing a fixed-length prefix that still contains the escape (the
 * bug this replaces: it compared `root + ownSuffix` against a raw slice of
 * the command text and never normalised anything, so a path that merely
 * *started* inside the session's own directory and then climbed out of it
 * matched the comparison and was let through).
 *
 * `resolve()` here has no `cwd` to normalise against, deliberately: a Bash
 * command runs with `cwd` set to the tool's own working directory, which
 * `path.resolve(token)` would silently fall back to if the token were ever
 * relative — but every token this function extracts starts with `root`,
 * already absolute, so a fallback to the wrong `cwd` should never be reachable
 * and is not something this function has to get right by accident.
 *
 * Fails closed: a `root` occurrence this cannot cleanly extract a token for,
 * or cannot resolve, is treated exactly like an escape rather than ignored.
 */
function everyRootUseIsOwn(command: string, root: string, ownUploadsDir: string): boolean {
  let index = command.indexOf(root)
  while (index !== -1) {
    let end = index
    while (end < command.length && !BASH_PATH_TOKEN_STOP.test(command[end] ?? '')) end++
    const token = command.slice(index, end)
    if (!token) return false
    let resolved: string
    try {
      resolved = resolve(token)
    } catch {
      return false
    }
    if (!isWithin(resolved, ownUploadsDir)) return false
    index = command.indexOf(root, index + root.length)
  }
  return true
}

/**
 * A second, tool-level layer over the attachments store, alongside the
 * `Options.settings` deny rules in `optionsFor` below. Neither is a security
 * boundary — see the note at the bottom of this function — but together they
 * are the strongest lever available on a host with no process isolation at
 * all: agent CLI processes are direct children of the worker, running as the
 * same OS user, no container, no uid switch.
 *
 * `settings.permissions.deny` (gitignore-style globs, no negation) can deny
 * `Read` on the whole attachments root only when a session has none — for a
 * session that does, "everything under the root except this session's own
 * subdirectory" is inexpressible in that rule language. This hook is what
 * covers that case: it runs for every matched tool, in the main thread and
 * inside every subagent alike (hook input carries `agent_id` when it fires
 * from one — `additionalDirectories` is already session-wide and a subagent
 * inherits the parent's cwd with no per-subagent scoping the SDK can express;
 * see issue #31940, closed as not planned — so that is the behaviour wanted
 * here too, not a gap).
 *
 * `ownUploadsDir === null` denies everything under the root outright — a
 * session with no attachments has nothing of its own to allow. The non-deny
 * return is always `{}` (silence), never `permissionDecision: 'allow'`:
 * unlike `delegationHook`, which returns 'allow' because it has an
 * `updatedInput` to attach, this hook never changes a tool call — returning
 * 'allow' here would make it a blanket approver for every file tool in the
 * system, which is the single easiest way to get this wrong.
 *
 * NOTE on what this does not cover, honestly: an agent can still reach
 * another session's files through a subprocess that opens them itself
 * (`python3 -c "open(...)"`) or through variable indirection in Bash — this
 * is a harness-level guard, not a kernel one. Separately, and out of scope
 * for this feature: `env: { ...process.env }` in `optionsFor` hands every
 * agent DATABASE_URL and REDIS_URL, which is a larger hole than the
 * filesystem one this hook narrows.
 */
export function attachmentsHook(ownUploadsDir: string | null): HookCallbackMatcher {
  const root = resolve(env.ATTACHMENTS_DIR)

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const { tool_name: name, tool_input, cwd } = input

    if (name === 'Bash') {
      const command =
        typeof (tool_input as { command?: unknown } | null)?.command === 'string'
          ? (tool_input as { command: string }).command
          : undefined
      if (command === undefined) {
        return denyOutsideOwn('Bash call carried no command string; denied as a precaution.')
      }
      if (!command.includes(root)) return {}
      if (ownUploadsDir && everyRootUseIsOwn(command, root, ownUploadsDir)) return {}
      return denyOutsideOwn(
        `This command reaches under ${root}, which only this session's own attachments directory may be touched under.`,
      )
    }

    if (!ATTACHMENT_GUARDED_TOOLS.has(name)) return {}

    const raw = pathInputFor(name, tool_input)
    if (raw === undefined) {
      return denyOutsideOwn(
        `Could not determine what ${name} would read or write; denied under the attachments root as a precaution.`,
      )
    }
    const resolved = resolve(cwd, raw)
    if (!isWithin(resolved, root)) return {}
    if (ownUploadsDir && isWithin(resolved, ownUploadsDir)) return {}
    return denyOutsideOwn(
      `${name} on ${resolved} is outside this session's own attachments directory.`,
    )
  }

  return { matcher: 'Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit', hooks: [hook] }
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

  // Null for a session with no files yet — checked fresh every turn, since an
  // upload can land between turns and this is what decides whether the next
  // one grants the directory at all.
  const attachments = await sessionAttachmentsSummary(session.id)
  const attachmentsRootGlob = `/${env.ATTACHMENTS_DIR}/**`

  // A custom string systemPrompt (below) suppresses the SDK's entire default
  // prompt, including its own "additional working directories" env block —
  // so this is the *only* thing that tells the main agent where its
  // attachments are. composeOrchestratorPrompt's output goes before the
  // SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker, which keeps it cacheable across
  // sessions; the attachments block goes after, since it is session-specific
  // and changes on every upload. Omitted (both the marker and the block, not
  // just the block) when there is nothing to say, which keeps the common
  // case — most sessions have no attachments — byte-identical to how this
  // looked before the feature existed, rather than a marker with nothing
  // following it that nobody has verified the SDK treats the same as absent.
  const composed = orchestrator
    ? await composeOrchestratorPrompt(orchestrator.prompt, orchestrator.team, specialists)
    : undefined
  const systemPrompt =
    composed === undefined
      ? undefined
      : attachments
        ? [
            composed,
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
            attachmentsSystemPromptBlock(
              attachments.uploadsDir,
              attachments.fileCount,
              attachments.manifestPath,
            ),
          ]
        : composed

  return {
    cwd,
    abortController,
    plugins: [{ type: 'local', path: pluginRoot }],
    // 'project' is what loads the repo's own CLAUDE.md, which is usually the
    // most useful context a project has.
    settingSources: ['project'],
    ...(systemPrompt !== undefined && { systemPrompt }),
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
    // a subagent cannot outlive the turn that spawned it, refuses agents
    // outside this project's roster, and (attachmentsHook) keeps a session's
    // file tools inside its own attachments directory.
    hooks: {
      PreToolUse: [delegationHook(specialists), attachmentsHook(attachments?.uploadsDir ?? null)],
    },
    // The strong lever: `deny` rules bind in every permission mode, including
    // bypassPermissions, cover every tool (not just Bash), and resolve
    // symlinks. Their gap is the rule language itself — gitignore-style globs
    // with no negation, so "everything under the root except this session's
    // own subdirectory" cannot be written as one rule. Edit/Write on the
    // whole root costs nothing to deny unconditionally: the store is user
    // data an agent must never mutate, and ATTACHMENTS.md is harness-
    // generated. Read is only deniable wholesale when there is nothing of the
    // agent's own under the root to need — attachmentsHook above is what
    // covers the case where there is.
    settings: {
      permissions: {
        deny: [
          `Edit(${attachmentsRootGlob})`,
          `Write(${attachmentsRootGlob})`,
          ...(attachments ? [] : [`Read(${attachmentsRootGlob})`]),
        ],
      },
    },
    // Never created until the first upload, and never the storage root —
    // only this session's own uploads directory.
    ...(attachments && { additionalDirectories: [attachments.uploadsDir] }),
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
