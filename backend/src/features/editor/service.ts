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
  inspectEditorContainer,
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
import type { EditorOperationDto, EditorState, EditorStatusDto } from './schema'

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

  // Step 6.
  const running = await countRunningEditorContainers(cli)
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
