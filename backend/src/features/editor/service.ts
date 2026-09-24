// Orchestration for the three editor routes. Mirrors docker/service.ts's own
// split: reads run inline; the one mutation that can take a while (starting a
// container, possibly after a `docker pull`) is built here but dispatched to
// the worker; the one that is always fast (`docker rm -f`) runs inline, like
// docker's own `stop`/`down` do not — see the design doc's own "Stop: inline"
// note for why an editor's stop gets no queue at all.
//
// Session scope only, always — unlike docker/scope.ts's DockerScopeRef, an
// editor never runs against a project's shared repo/ checkout (see the
// design doc's "Scope" section), so every function here takes a required
// `sessionId`, never an optional one.

import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects, sessions } from '@/db/schema'
import { editorEnabled, env } from '@/env'
import { type DockerCli, realDockerCli } from '@/features/docker/cli'
import { type ContainerState, getDaemonVersion } from '@/features/docker/inspect'
import { type EditorScopeRef, editorContainerName } from '@/features/docker/names'
import { resolveDockerScope } from '@/features/docker/scope'
import { conflict, forbidden, serviceUnavailable } from '@/lib/errors'
import { editorSocketPath } from '@/lib/paths'
import { enqueueEditorStart } from '@/queue'
import {
  countRunningEditorContainers,
  type EditorHealthProbe,
  inspectEditorContainer,
  listThisInstallRunningEditors,
  probeEditorHealth,
  probeEditorHealthz,
  removeEditorContainer,
} from './container'
import {
  claimEditorLock,
  createEditorOperation,
  editorLockHolder,
  finishEditorOperation,
  getEditorOperation,
  getEditorOperationOutput,
  lastEditorOperationId,
  releaseEditorLock,
} from './operations'
import { editorProxyPath } from './proxy'
import type {
  EditorHealth,
  EditorOperationDto,
  EditorState,
  EditorStatusDto,
  RunningEditorDto,
  RunningEditorsDto,
} from './schema'

/** Duplicated from docker/service.ts's own two constants, deliberately —
 * see the design doc's own note: this feature's 503s should not have to
 * import that module just to phrase a recovery hint identically. */
const DAEMON_RECOVERY_COMMANDS = ['sudo systemctl status docker', 'sudo systemctl start docker']
const CLI_MISSING_RECOVERY_COMMANDS = [
  '# docker is not installed on this host',
  'curl -fsSL https://get.docker.com | sudo sh',
]

/** How long GET .../editor waits for a probe before giving up on "running,
 * but not answering" — matches the design's own "2s /healthz probe". */
const STATUS_HEALTHZ_TIMEOUT_MS = 2_000

/**
 * The single state-derivation rule this feature has (design doc, "State
 * derivation"). Pure and exported so editor-state.test.ts can enumerate every
 * row of the table directly, with no daemon, no Redis, and no session in
 * play.
 */
export function deriveEditorState(input: {
  lockHeld: boolean
  containerState: ContainerState | undefined
  healthy: boolean
}): EditorState {
  if (input.lockHeld) return 'starting'
  if (input.containerState === 'running') return input.healthy ? 'running' : 'unresponsive'
  return 'stopped'
}

/**
 * The operation this session's status reports, decided at read time — never
 * written back to Redis. A `queued`/`running` record whose lock is gone did
 * not simply take a while; the worker that owned it is either dead or
 * exceeded its own deadline, and nothing will ever finish that record for it.
 */
async function currentOperationDto(
  sessionId: string,
  lockHeld: boolean,
): Promise<EditorOperationDto | null> {
  const operationId = await lastEditorOperationId(sessionId)
  if (!operationId) return null
  const record = await getEditorOperation(operationId)
  if (!record) return null
  const output = await getEditorOperationOutput(operationId)

  if (!lockHeld && (record.status === 'queued' || record.status === 'running')) {
    return {
      id: record.id,
      status: 'failed',
      error: 'The start did not finish (worker unavailable or timed out)',
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      output,
    }
  }
  return { ...record, output }
}

export async function getEditorStatus(
  projectId: string,
  sessionId: string,
  cli: DockerCli = realDockerCli,
): Promise<EditorStatusDto> {
  const scope = await resolveDockerScope(projectId, sessionId) // 400/404/409
  const ref: EditorScopeRef = { slug: scope.slug, sessionId }
  const name = editorContainerName(ref)

  const [daemon, container, lockHolder] = await Promise.all([
    getDaemonVersion(cli),
    inspectEditorContainer(name, cli),
    editorLockHolder(sessionId),
  ])
  const lockHeld = lockHolder !== undefined

  const healthy =
    container?.state === 'running'
      ? await probeEditorHealthz(editorSocketPath(sessionId), STATUS_HEALTHZ_TIMEOUT_MS)
      : false

  const state = deriveEditorState({ lockHeld, containerState: container?.state, healthy })
  const operation = await currentOperationDto(sessionId, lockHeld)

  return {
    projectId,
    sessionId,
    enabled: editorEnabled,
    daemon: { cliInstalled: daemon.cliInstalled, available: daemon.available, error: daemon.error },
    state,
    proxyPath: editorProxyPath(projectId, sessionId),
    worktreePath: scope.path,
    image: env.EDITOR_IMAGE,
    idleTimeoutSeconds: env.EDITOR_IDLE_TIMEOUT_SECONDS,
    container: container
      ? { name: container.name, state: container.state, startedAt: container.startedAt }
      : null,
    operation,
    fetchedAt: new Date().toISOString(),
  }
}

/** See the design doc's own numbered "Start route order" — this follows it
 * step for step; each is called out below. */
export async function requestEditorStart(
  projectId: string,
  sessionId: string,
  cli: DockerCli = realDockerCli,
): Promise<EditorStatusDto> {
  // Step 1.
  if (!editorEnabled) {
    throw forbidden('The editor is disabled (DOCKER_ENABLED or EDITOR_ENABLED is false)')
  }

  // Step 2.
  const scope = await resolveDockerScope(projectId, sessionId) // 400/404/409

  // Step 3.
  const daemon = await getDaemonVersion(cli)
  if (!daemon.cliInstalled) {
    throw serviceUnavailable('docker is not installed on this host', CLI_MISSING_RECOVERY_COMMANDS)
  }
  if (!daemon.available) {
    throw serviceUnavailable(
      `the docker daemon is not reachable${daemon.error ? `: ${daemon.error}` : ''}`,
      DAEMON_RECOVERY_COMMANDS,
    )
  }

  const ref: EditorScopeRef = { slug: scope.slug, sessionId }
  const name = editorContainerName(ref)

  // Step 4.
  const existing = await inspectEditorContainer(name, cli)
  if (
    existing?.state === 'running' &&
    (await probeEditorHealthz(editorSocketPath(sessionId), STATUS_HEALTHZ_TIMEOUT_MS))
  ) {
    return getEditorStatus(projectId, sessionId, cli)
  }

  // Step 5: a start already in flight owns the lock, so this request just
  // reports it back rather than queuing a second one alongside it.
  const operationId = randomUUID()
  const claimed = await claimEditorLock(sessionId, operationId, env.EDITOR_START_TIMEOUT_MS)
  if (!claimed) {
    return getEditorStatus(projectId, sessionId, cli)
  }

  // Step 6: this session's own container — if Step 4 above found one at
  // all, it's running but unresponsive, since a healthy one already
  // short-circuited above — is excluded from the count. Restarting it is not
  // asking the cap for a second slot; the worker's own start job (lifecycle.ts
  // step 4) removes this very container before it runs the same check again.
  // See countRunningEditorContainers's own comment (container.ts) for why
  // that matters at the cap.
  const running = await countRunningEditorContainers(cli, { excludeName: name })
  if (running >= env.EDITOR_MAX_RUNNING) {
    await releaseEditorLock(sessionId, operationId)
    throw conflict(`The editor container cap (${env.EDITOR_MAX_RUNNING} running) is reached`)
  }

  // Step 7.
  await createEditorOperation(sessionId, operationId)

  // Step 8.
  try {
    await enqueueEditorStart({ kind: 'start', operationId, projectId, sessionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishEditorOperation(operationId, 'failed', `Could not queue the start: ${message}`)
    await releaseEditorLock(sessionId, operationId)
    throw error
  }

  return getEditorStatus(projectId, sessionId, cli)
}

export async function requestEditorStop(
  projectId: string,
  sessionId: string,
  cli: DockerCli = realDockerCli,
): Promise<EditorStatusDto> {
  if (!editorEnabled) {
    throw forbidden('The editor is disabled (DOCKER_ENABLED or EDITOR_ENABLED is false)')
  }

  const scope = await resolveDockerScope(projectId, sessionId) // 400/404/409

  const lockHolder = await editorLockHolder(sessionId)
  if (lockHolder !== undefined) {
    throw conflict(
      'A start is already in progress for this session; wait for it to finish before stopping',
    )
  }

  const daemon = await getDaemonVersion(cli)
  if (!daemon.cliInstalled) {
    throw serviceUnavailable('docker is not installed on this host', CLI_MISSING_RECOVERY_COMMANDS)
  }
  if (!daemon.available) {
    throw serviceUnavailable(
      `the docker daemon is not reachable${daemon.error ? `: ${daemon.error}` : ''}`,
      DAEMON_RECOVERY_COMMANDS,
    )
  }

  const ref: EditorScopeRef = { slug: scope.slug, sessionId }
  const name = editorContainerName(ref)

  // Idempotent by construction: `docker rm -f` on a container that is
  // already gone (or never existed) still leaves this session with no
  // container, which is exactly the `stopped` state below reports. Only
  // logged, never thrown, so a stop request never fails just because there
  // was nothing left to remove.
  const result = await removeEditorContainer(name, cli)
  if (!result.ok && !/no such container/i.test(result.stderr)) {
    throw serviceUnavailable(
      `could not remove the editor container: ${result.stderr}`,
      DAEMON_RECOVERY_COMMANDS,
    )
  }

  return getEditorStatus(projectId, sessionId, cli)
}

// --- GET /editors: every editor holding a running-cap slot -------------------
//
// Deliberately its own section, not folded into getEditorStatus above: that
// function answers "what is THIS session's own editor doing"; this answers
// "who, box-wide install-scoped, is holding the cap this session just got
// refused by" — see the design brief's own "Why" for the report this exists
// to answer.

/** Probed with a short timeout so this endpoint stays fast even at the cap —
 * every listed editor is probed in parallel (Promise.all below), never in a
 * loop, so the total wait is one timeout, not N of them. */
const RUNNING_EDITORS_HEALTHZ_TIMEOUT_MS = 1_000

/**
 * The session title/branch and project name `listRunningEditors` needs to
 * name who is using each running slot — one pair of bulk selects for every
 * session id at once (never `getSessionLocation`/`getProject` per container,
 * docker/scope.ts's own single-lookup pattern): the id count here is bounded
 * by EDITOR_MAX_RUNNING, but there is still no reason to pay N+1 queries for
 * it. Two selects rather than one SQL join, the same discipline
 * sessions/service.ts's own `filesForMessages` already uses for a bulk
 * by-ids read: simpler to fake in a test, and just as correct here since
 * this is never on a hot path a join's single round trip would meaningfully
 * help.
 *
 * A session id absent from the returned map — its row deleted, or its
 * project's — is exactly the orphan case `listRunningEditors` already treats
 * as "leave out of `editors`, still counted in `running`" (see that
 * function's own comment), so this never throws for a vanished session; it
 * simply omits it.
 */
async function sessionSummariesFor(
  sessionIds: string[],
): Promise<
  Map<
    string,
    { projectId: string; projectName: string; title: string | null; branch: string | null }
  >
> {
  if (sessionIds.length === 0) return new Map()

  const sessionRows = await db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      title: sessions.title,
      branch: sessions.branch,
    })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
  if (sessionRows.length === 0) return new Map()

  const projectIds = [...new Set(sessionRows.map((row) => row.projectId))]
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds))
  const projectNameById = new Map(projectRows.map((row) => [row.id, row.name]))

  const out = new Map<
    string,
    { projectId: string; projectName: string; title: string | null; branch: string | null }
  >()
  for (const row of sessionRows) {
    const projectName = projectNameById.get(row.projectId)
    // The project itself is gone (deleted out from under a session that
    // somehow survived it) — as much an orphan as a deleted session; treated
    // identically by simply not appearing in the map.
    if (projectName === undefined) continue
    out.set(row.id, { projectId: row.projectId, projectName, title: row.title, branch: row.branch })
  }
  return out
}

/** `alive` -> 'in-use', `expired` -> 'idle', anything else (no answer, or an
 * unparseable body) -> 'unresponsive' — the design brief's own mapping,
 * verbatim. `alive === null` covers both "didn't answer" and "answered with
 * garbage" identically: neither is evidence of a connected tab, and neither
 * is evidence of one having left either, so 'unresponsive' (not 'idle') is
 * the honest label for both. */
function editorHealthFrom(probe: EditorHealthProbe): EditorHealth {
  if (probe.alive === true) return 'in-use'
  if (probe.alive === false) return 'idle'
  return 'unresponsive'
}

/** `0` is code-server's own "never seen a heartbeat", not a real timestamp —
 * reported as `null`, same as a probe that never got a `lastHeartbeat` back
 * at all, rather than as the epoch. */
function lastActiveAtFrom(probe: EditorHealthProbe): string | null {
  return probe.lastHeartbeat ? new Date(probe.lastHeartbeat).toISOString() : null
}

/** idle, then unresponsive, then in-use (the design brief's own order: the
 * editors least likely to be wanted first) — within each group, oldest
 * `lastActiveAt` first, nulls first. ISO strings sort lexicographically in
 * the same order they sort chronologically, so a plain string compare is
 * exact here, not an approximation. */
const RUNNING_EDITOR_HEALTH_ORDER: Record<EditorHealth, number> = {
  idle: 0,
  unresponsive: 1,
  'in-use': 2,
}

function compareRunningEditors(a: RunningEditorDto, b: RunningEditorDto): number {
  const byHealth = RUNNING_EDITOR_HEALTH_ORDER[a.health] - RUNNING_EDITOR_HEALTH_ORDER[b.health]
  if (byHealth !== 0) return byHealth
  if (a.lastActiveAt === b.lastActiveAt) return 0
  if (a.lastActiveAt === null) return -1
  if (b.lastActiveAt === null) return 1
  return a.lastActiveAt < b.lastActiveAt ? -1 : 1
}

/**
 * Every editor holding a running-cap slot, and how many more of them exist on
 * the box than this install can (or should) name individually. See the
 * design brief's own "Why": this is what a start refused at the cap points a
 * user at, so they know which editor(s) to stop.
 */
export async function listRunningEditors(
  cli: DockerCli = realDockerCli,
): Promise<RunningEditorsDto> {
  const fetchedAt = new Date().toISOString()

  // A disabled feature has never started a container to begin with —
  // answering zeros here is the same "not a server fault" discipline
  // getEditorStatus's own `enabled: false` already follows (see its route's
  // own description in routes.ts).
  if (!editorEnabled) {
    return {
      enabled: false,
      cap: env.EDITOR_MAX_RUNNING,
      running: 0,
      otherInstallsRunning: 0,
      editors: [],
      fetchedAt,
    }
  }

  // `running` is deliberately the SAME unscoped, unexcluded count a start
  // request compares against the cap (countRunningEditorContainers's own
  // comment, container.ts) — so `running >= cap` here means exactly what it
  // means there. Neither this call nor `listThisInstallRunningEditors` ever
  // throws when the daemon (or docker itself) is unavailable; each already
  // degrades to an empty/zero result (see their own comments), which is
  // already this endpoint's own "docker is down" answer — nothing else to
  // special-case here.
  const [running, thisInstall] = await Promise.all([
    countRunningEditorContainers(cli),
    listThisInstallRunningEditors(cli),
  ])

  const sessionIds = thisInstall
    .map((container) => container.sessionId)
    .filter((id): id is string => id !== null)
  const summaries = await sessionSummariesFor(sessionIds)

  // Probed in parallel, not in a loop — see RUNNING_EDITORS_HEALTHZ_TIMEOUT_MS's
  // own comment for why that matters here specifically.
  const editors = (
    await Promise.all(
      thisInstall.map(async (container): Promise<RunningEditorDto | null> => {
        if (!container.sessionId) return null // no session label at all -- an orphan, see below
        const summary = summaries.get(container.sessionId)
        // Orphaned: this container's session (or its project) no longer
        // resolves. Left out of `editors` — there is nothing true to report
        // as its project/session names — but already counted in `running`
        // above; runEditorReap (reaper.ts) removes it within its own
        // 5-minute schedule.
        if (!summary) return null

        const probe = await probeEditorHealth(
          editorSocketPath(container.sessionId),
          RUNNING_EDITORS_HEALTHZ_TIMEOUT_MS,
        )

        return {
          projectId: summary.projectId,
          projectName: summary.projectName,
          sessionId: container.sessionId,
          sessionTitle: summary.title,
          branch: summary.branch,
          containerName: container.name,
          startedAt: container.startedAt,
          health: editorHealthFrom(probe),
          lastActiveAt: lastActiveAtFrom(probe),
        }
      }),
    )
  ).filter((editor): editor is RunningEditorDto => editor !== null)
  editors.sort(compareRunningEditors)

  return {
    enabled: true,
    cap: env.EDITOR_MAX_RUNNING,
    running,
    // Clamped at 0 against the two docker reads above (`running` and
    // `thisInstall`) racing each other — each is its own `docker`
    // invocation, run concurrently, so a container that stops (or starts)
    // between them can otherwise make this install's own count of its own
    // containers momentarily exceed the box-wide total. A transient render
    // glitch, not a bug to propagate as a negative "other installs" count.
    otherInstallsRunning: Math.max(0, running - thisInstall.length),
    editors,
    fetchedAt,
  }
}
