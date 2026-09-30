// The system-wide Docker page: every container on the daemon, across every
// project this install knows about (and every one it doesn't — the daemon is
// shared with other agentoo installs on this box, same as editorInstallId's
// own reasoning in features/editor/container.ts), plus a single-container
// stop.
//
// Deliberately NOT in containers.ts: that module is a leaf sessions/service.ts
// itself imports (see its own header), so it must never import
// projects/service.ts or sessions/service.ts back — doing so here instead,
// the way scope.ts and service.ts already do, is what keeps that leaf a leaf.
//
// The owner-resolution join (candidates -> this install's own projects and
// sessions) is batched into exactly two queries regardless of how many
// containers are on the box, because GET /docker/containers is meant to be
// polled every few seconds: one `listProjects()` (already a single query —
// see its own comment on why this feature reuses it rather than a second,
// near-identical one) and one `listSessionsForProjects` for whichever
// projects a candidate's slug actually matched. The matching logic itself
// (`resolveContainerOwners`) is a pure function over plain rows, so it is
// unit-testable with no database at all.

import { env } from '@/env'
import { listProjects } from '@/features/projects/service'
import { listSessionsForProjects, type SessionOwnerRow } from '@/features/sessions/service'
import { badGateway, conflict, forbidden, notFound, serviceUnavailable } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { dockerStopArgs } from './args'
import { type DockerCli, realDockerCli } from './cli'
import type { ContainerInspectRaw, PublishedPort } from './inspect'
import {
  getDaemonVersion,
  inspectContainersRaw,
  inspectContainersRawAll,
  listAllContainerIds,
  toDockerContainer,
} from './inspect'
import { type ContainerOwnerCandidate, parseContainerOwner } from './names'
import { activeOperationForScope, dockerLockScope } from './operations'
import type { ContainerOwnerDto, DockerSystemDto, SystemContainerDto } from './schema'
import {
  CLI_MISSING_RECOVERY_COMMANDS,
  DAEMON_RECOVERY_COMMANDS,
  DOCKER_DISABLED_MESSAGE,
} from './service'

// --- the pure owner matcher ---------------------------------------------------

/** The columns `resolveContainerOwners` needs off a project row — a subset of
 * `ProjectDto`, which is passed in directly (structurally compatible). */
export interface OwnerProjectRow {
  id: string
  slug: string
  name: string
}

/** Same shape as sessions/service.ts's own `SessionOwnerRow` — re-exported
 * under this name so this module's pure matcher has no import-time dependency
 * on that one, only a structural (type-checked) agreement with it. */
export type OwnerSessionRow = SessionOwnerRow

/**
 * Join candidates parsed off container labels (`parseContainerOwner`,
 * names.ts) against this install's own projects and sessions. Pure: no I/O,
 * no clock, so docker-system.test.ts can pin every rule below with plain
 * arrays and no database.
 *
 * Rules (see the brief this feature was built from):
 *   - An unknown slug (a container labelled for some other agentoo install
 *     sharing this daemon, or a foreign `docker compose up`) is owner: null.
 *   - Repo scope (no session part) resolves to that project alone.
 *   - Session scope resolves only if the session exists, belongs to that
 *     project, and is isolated (`worktreePath` non-null) — never falls back
 *     to repo scope, which would point at the wrong worktree entirely.
 *   - A compose session prefix (hex12) must match EXACTLY one of the
 *     project's isolated sessions; zero or more than one is owner: null.
 */
export function resolveContainerOwners(
  candidates: ReadonlyArray<ContainerOwnerCandidate | null>,
  projects: readonly OwnerProjectRow[],
  sessions: readonly OwnerSessionRow[],
): Array<ContainerOwnerDto | null> {
  const projectsBySlug = new Map(projects.map((p) => [p.slug, p] as const))

  return candidates.map((candidate) => {
    if (!candidate) return null
    const project = projectsBySlug.get(candidate.slug)
    if (!project) return null

    if (candidate.sessionId === null && candidate.sessionPrefix === null) {
      return {
        kind: candidate.kind,
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
        sessionId: null,
        sessionTitle: null,
        branch: null,
      }
    }

    // Isolated only: a session sharing the project checkout has no worktree
    // of its own to have run docker in (see docker/scope.ts's own gate), so
    // matching it here would attribute a container to a session that could
    // never actually have produced it.
    const isolated = sessions.filter((s) => s.projectId === project.id && s.worktreePath !== null)

    let matched: OwnerSessionRow | undefined
    if (candidate.sessionPrefix !== null) {
      const prefix = candidate.sessionPrefix
      const matches = isolated.filter((s) => s.id.replace(/-/g, '').startsWith(prefix))
      matched = matches.length === 1 ? matches[0] : undefined
    } else if (candidate.sessionId !== null) {
      const sessionId = candidate.sessionId
      matched = isolated.find((s) => s.id === sessionId)
    }
    if (!matched) return null

    return {
      kind: candidate.kind,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      sessionId: matched.id,
      sessionTitle: matched.title,
      branch: matched.branch,
    }
  })
}

/** Batches the DB side of owner resolution for a set of already-inspected
 * containers: one `listProjects()`, one `listSessionsForProjects` scoped to
 * whichever projects a candidate slug actually matched, then the pure
 * matcher above. Used by both the listing (many containers) and the stop
 * endpoint (one), so a single container being stopped costs exactly the same
 * two queries as the whole-host listing, never a per-container round trip. */
async function resolveOwnersForRaws(
  raws: readonly ContainerInspectRaw[],
): Promise<Array<ContainerOwnerDto | null>> {
  const candidates = raws.map((raw) => parseContainerOwner(raw.Config?.Labels ?? undefined))
  const slugs = new Set(
    candidates.filter((c): c is ContainerOwnerCandidate => c !== null).map((c) => c.slug),
  )
  if (slugs.size === 0) return candidates.map(() => null)

  const allProjects = await listProjects()
  const matchedProjects = allProjects.filter((p) => slugs.has(p.slug))
  if (matchedProjects.length === 0) return candidates.map(() => null)

  const sessions = await listSessionsForProjects(matchedProjects.map((p) => p.id))
  return resolveContainerOwners(candidates, matchedProjects, sessions)
}

// --- ports: never a bind address ----------------------------------------------

/** Distinct published HOST port numbers, ascending — an IPv4 `0.0.0.0` and an
 * IPv6 `[::]` binding of the same port collapse to one entry because this
 * only ever looks at `hostPort`; `hostIp` never reaches this function, let
 * alone the wire (see `SystemContainerDto.ports`, schema.ts). */
export function distinctHostPorts(ports: readonly Pick<PublishedPort, 'hostPort'>[]): number[] {
  return [...new Set(ports.map((p) => p.hostPort))].sort((a, b) => a - b)
}

function toSystemContainer(
  raw: ContainerInspectRaw,
  owner: ContainerOwnerDto | null,
): SystemContainerDto {
  const container = toDockerContainer(raw)
  return {
    id: container.id,
    shortId: container.shortId,
    name: container.name,
    image: container.image,
    state: container.state,
    health: container.health,
    exitCode: container.exitCode,
    createdAt: container.createdAt,
    startedAt: container.startedAt,
    finishedAt: container.finishedAt,
    composeProject: raw.Config?.Labels?.['com.docker.compose.project'] ?? null,
    service: container.service,
    ports: distinctHostPorts(container.ports),
    owner,
  }
}

// --- GET /docker/containers ----------------------------------------------------

/**
 * Always 200, the same philosophy as `GET /projects/{id}/docker`: a missing
 * CLI or an unreachable daemon is a legitimate state of the *page*, not a
 * server fault, so it is reported through `daemon` with `containers: []`
 * rather than a 5xx. Reads are never gated by `DOCKER_ENABLED` — only the
 * stop endpoint is — so `enabled: false` still returns a real container list.
 */
export async function getSystemDockerState(
  cli: DockerCli = realDockerCli,
): Promise<DockerSystemDto> {
  const daemon = await getDaemonVersion(cli)
  const daemonDto = {
    cliInstalled: daemon.cliInstalled,
    available: daemon.available,
    version: daemon.version,
    error: daemon.error,
  }

  if (!daemon.cliInstalled || !daemon.available) {
    return {
      enabled: env.DOCKER_ENABLED,
      daemon: daemonDto,
      containers: [],
      fetchedAt: new Date().toISOString(),
    }
  }

  const ids = await listAllContainerIds(cli)
  const raws = await inspectContainersRawAll(ids, cli)
  const owners = await resolveOwnersForRaws(raws)
  const containers = raws
    .map((raw, i) => toSystemContainer(raw, owners[i] ?? null))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    enabled: env.DOCKER_ENABLED,
    daemon: daemonDto,
    containers,
    fetchedAt: new Date().toISOString(),
  }
}

// --- POST /docker/containers/{containerId}/stop --------------------------------

/**
 * `docker stop` bound — this is only how long this route waits for the
 * daemon to answer, not a grace period imposed on the container: no `-t` is
 * ever passed (see dockerStopArgs, args.ts), so the daemon still honours each
 * container's own configured stop-timeout (Postgres, notably, needs real
 * shutdown time). 30s mirrors EDITOR_RUN_TIMEOUT_MS's own reasoning
 * (features/editor/container.ts) — generous headroom for a loaded host, not a
 * value an ordinary stop should ever actually take.
 */
const SYSTEM_STOP_TIMEOUT_MS = 30_000

/** `docker stop`'s own wording for an id it does not recognise — matched
 * case-insensitively since the exact casing has drifted across engine
 * versions, and this only ever gates which AppError status a failure gets. */
const NO_SUCH_CONTAINER_RE = /no such container/i

export async function stopSystemContainer(
  containerId: string,
  cli: DockerCli = realDockerCli,
): Promise<SystemContainerDto | null> {
  // Cheapest check first, exactly like requestOperation (service.ts): a
  // disabled feature answers 403 before a single docker call is made.
  if (!env.DOCKER_ENABLED) throw forbidden(DOCKER_DISABLED_MESSAGE)

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

  const [before] = await inspectContainersRaw([containerId], cli)
  if (!before) throw notFound('Container')

  const owner = (await resolveOwnersForRaws([before]))[0] ?? null

  // Refuse to stop underneath a running compose/dockerfile operation on this
  // same scope — the exact race requestOperation's own lock check guards
  // against on the "up" side. Editor-owned containers are not checked
  // against features/editor's own start lock: features/docker/* never
  // imports features/editor/* (see features/editor/container.ts's own header
  // on this one-way layering), and it is unnecessary anyway — the reaper
  // already removes any editor container that is not running, so a stopped
  // one mid-start is always safe to have stopped.
  if (owner && (owner.kind === 'compose' || owner.kind === 'dockerfile')) {
    const lockScope = dockerLockScope(owner.projectId, owner.sessionId)
    let activeOperationId: string | undefined
    try {
      activeOperationId = await activeOperationForScope(lockScope)
    } catch (error) {
      // Refuse rather than stop blind: without this check a Redis blip would
      // otherwise surface as a generic 500 (an uncaught throw reaching
      // dockerRouter's own onError) instead of the same 503 every other
      // "docker's own infrastructure is unavailable" case in this feature
      // already answers with.
      const message = error instanceof Error ? error.message : String(error)
      throw serviceUnavailable(
        `Could not check for an in-flight docker operation on this project: ${message}`,
      )
    }
    if (activeOperationId) {
      throw conflict(
        `Another docker operation (${activeOperationId}) is already running for this project; ` +
          'refusing to stop underneath it',
      )
    }
  }

  const name = (before.Name ?? '').replace(/^\//, '') || containerId
  logger.info(
    `Docker system stop: ${name} (${containerId})` +
      (owner
        ? ` [owner: ${owner.kind} ${owner.projectSlug}${owner.sessionId ? ` session ${owner.sessionId}` : ''}]`
        : ''),
  )

  const result = await cli.run(dockerStopArgs(containerId), { timeoutMs: SYSTEM_STOP_TIMEOUT_MS })
  if (!result.ok) {
    if (NO_SUCH_CONTAINER_RE.test(result.stderr)) throw notFound('Container')
    // -1 is cli.ts's own sentinel for "ran, but we have no exit code" — a
    // timeout kill in `realDockerCli.run` (see its own comment). Anything
    // else is some other docker-reported failure, quoted verbatim.
    if (result.exitCode === -1) {
      throw badGateway(
        `docker stop timed out after ${SYSTEM_STOP_TIMEOUT_MS}ms; the container may still be stopping`,
      )
    }
    throw badGateway(`docker stop failed: ${result.stderr || 'unknown error'}`)
  }

  // Stopping an already-stopped container is idempotent in docker itself
  // (exit 0), so there is no separate "already stopped" branch above — this
  // re-inspect is what reports its actual (possibly unchanged) state either
  // way. A `--rm` container is gone by the time this runs — the daemon
  // removed it itself the moment it stopped — which is a SUCCESSFUL stop,
  // not a 404: the request that reaches here already knows the container
  // existed (the pre-stop inspect above), and `docker stop` itself exited 0.
  // `null` is how the caller tells "stopped, then auto-removed" apart from
  // every other shape of "not found" this function still throws for (a bad
  // id before any docker call was even made, or the daemon already not
  // knowing this id before the stop was attempted).
  const [after] = await inspectContainersRaw([containerId], cli)
  return after ? toSystemContainer(after, owner) : null
}
