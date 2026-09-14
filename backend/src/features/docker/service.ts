// Orchestration: everything routes.ts calls. Reads (this file's read-only
// exports) run inline, bounded by DOCKER_READ_TIMEOUT_MS deep in cli.ts; every
// mutation is built here but *dispatched* to the worker (queue/docker-op.worker.ts)
// — see the brief's "execution split" for why `compose up -d --build` cannot
// run inside an HTTP request.
//
// Every read and write below resolves a `DockerScope` first (see scope.ts) —
// the project's own repo/ checkout, or one session's independent worktree —
// and everything downstream (detection, compose files, the container
// listing, the queued job) is built from that scope's own `.path`, never from
// the project row directly. Repo scope (no `?sessionId`) is required to stay
// byte-identical to this feature's behaviour before sessions had worktrees of
// their own: same names, same lock keys, same argv.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '@/env'
import { getProject, listProjects } from '@/features/projects/service'
import { badRequest, conflict, forbidden, notFound, serviceUnavailable } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectRepo } from '@/lib/paths'
import { type DockerOpJob, enqueueDockerOp } from '@/queue'
import type { ComposeFiles } from './args'
import { type DockerCli, realDockerCli } from './cli'
import { foreignStacksFor, getComposeConfig, getComposeVersion } from './compose-config'
import { composeEnvFor } from './compose-env'
import { listScopeContainers } from './containers'
import { type Detection, detectProjectDocker } from './detect'
import { parseExposedPorts } from './dockerfile'
import { getHostAddresses } from './hosts'
import {
  containerIdentity,
  getDaemonVersion,
  inspectContainers,
  inspectImage,
  listContainerIds,
} from './inspect'
import { composeProjectLabelFilter, composeProjectName, imageReference } from './names'
import {
  activeOperationForScope,
  createOperation,
  dockerLockScope,
  finishOperation,
  getOperation,
  listOperationsForProject,
} from './operations'
import type {
  DockerDetectionListDto,
  DockerOperationDto,
  DockerOperationKind,
  DockerServiceDto,
  DockerStateDto,
  DownRequestInput,
  ServiceSelectionInput,
  UpRequestInput,
} from './schema'
import type { DockerScope } from './scope'
import { resolveDockerScope } from './scope'

// --- detection, cached -------------------------------------------------------

/**
 * How long a project's compose/Dockerfile detection is trusted before
 * re-stat'ing. GET /docker/detection answers every project in one response
 * and is meant to be polled cheaply by a Docker nav badge — not per-project
 * like GET /projects/{id}/docker, which never uses this cache (its own daemon
 * reads dominate the cost of a fresh `stat` anyway).
 *
 * Repo scope only, deliberately — per-scope detection for every session's
 * worktree is out of scope for this feature (see the brief): this cache, and
 * this endpoint, answer for the project's own repo/ checkout alone.
 */
const DETECT_TTL_MS = 10_000
const detectionCache = new Map<string, { at: number; value: Detection }>()

async function cachedDetection(slug: string): Promise<Detection> {
  const now = Date.now()
  const cached = detectionCache.get(slug)
  if (cached && now - cached.at < DETECT_TTL_MS) return cached.value
  const value = await detectProjectDocker(projectRepo(slug))
  detectionCache.set(slug, { at: now, value })
  return value
}

export async function listDockerDetections(): Promise<DockerDetectionListDto> {
  if (!env.DOCKER_ENABLED) return { enabled: false, projects: [] }

  // Reuses the existing project listing rather than a second, near-identical
  // query — one less place that has to agree with `projects/service.ts` on
  // what a project row even is, and (worth noting, not the reason for it)
  // one less test in this feature that has to reach for `@/db/client`
  // directly.
  const all = await listProjects()
  const results = await Promise.all(
    all.map(async (project) => {
      const detection = await cachedDetection(project.slug)
      return { ...detection, projectId: project.id, slug: project.slug }
    }),
  )
  return { enabled: true, projects: results }
}

// --- state --------------------------------------------------------------------

function serviceStateFor(
  containers: { state: string }[],
): 'running' | 'partial' | 'stopped' | 'absent' {
  if (containers.length === 0) return 'absent'
  const runningCount = containers.filter((c) => c.state === 'running').length
  if (runningCount === containers.length) return 'running'
  if (runningCount === 0) return 'stopped'
  return 'partial'
}

/** Absolute, checked path for a basename `detectProjectDocker` found inside
 * this scope's own directory — never built from anything a client sent. */
function resolveDetected(scopePath: string, basename: string): string {
  return assertInsideProjects(join(scopePath, basename))
}

export async function getProjectDockerState(
  projectId: string,
  sessionId?: string,
  cli: DockerCli = realDockerCli,
): Promise<DockerStateDto> {
  const scope = await resolveDockerScope(projectId, sessionId) // 404s / 400s / 409s

  const detection = await detectProjectDocker(scope.path)

  const [daemonVersion, activeOperationId, hosts] = await Promise.all([
    getDaemonVersion(cli),
    activeOperationForScope(dockerLockScope(scope.projectId, scope.sessionId)).catch((error) => {
      logger.warn(`Could not read the active docker operation for ${projectId}: ${String(error)}`)
      return undefined
    }),
    getHostAddresses(),
  ])
  const composeVersion = daemonVersion.cliInstalled ? await getComposeVersion(cli) : null

  let composeName: string | null = null
  let configError: string | null = null
  let composeServices: Awaited<ReturnType<typeof getComposeConfig>>['services'] = []
  let foreignStacks: Awaited<ReturnType<typeof foreignStacksFor>> = []

  if (detection.hasCompose && detection.composeFile) {
    composeName = composeProjectName(scope)
    const files: ComposeFiles = {
      base: resolveDetected(scope.path, detection.composeFile),
      override: detection.composeOverrideFile
        ? resolveDetected(scope.path, detection.composeOverrideFile)
        : undefined,
    }

    const run = { cwd: scope.path, env: composeEnvFor(scope) }
    const configResult = await getComposeConfig(composeName, files, run, cli)
    configError = configResult.configError
    composeServices = configResult.services
    foreignStacks = await foreignStacksFor(composeName, files.base, cli)
  }

  let dockerfilePorts: DockerStateDto['dockerfilePorts'] = []
  let image: DockerStateDto['image'] = null
  if (detection.hasDockerfile && detection.dockerfile) {
    const dockerfileAbsPath = resolveDetected(scope.path, detection.dockerfile)
    try {
      dockerfilePorts = parseExposedPorts(await readFile(dockerfileAbsPath, 'utf8'))
    } catch (error) {
      logger.warn(`Could not read ${dockerfileAbsPath}: ${String(error)}`)
    }

    const reference = imageReference(scope)
    const imageInfo = await inspectImage(reference, cli)
    image = { reference, ...imageInfo }
  }

  const containers = await listScopeContainers(scope, cli)

  const services: DockerServiceDto[] = composeServices.map((svc) => {
    const matched = containers.filter((c) => c.service === svc.name)
    return {
      name: svc.name,
      image: svc.image,
      build: svc.build,
      profiles: svc.profiles,
      dependsOn: svc.dependsOn,
      declaredPorts: svc.declaredPorts,
      containerIds: matched.map((c) => c.id),
      state: serviceStateFor(matched),
    }
  })

  return {
    projectId,
    sessionId: scope.sessionId,
    // Always the repo checkout, regardless of scope — scopePath below is the
    // directory this state was actually read from.
    projectPath: projectRepo(scope.slug),
    scopePath: scope.path,
    composeProject: composeName,
    daemon: {
      cliInstalled: daemonVersion.cliInstalled,
      available: daemonVersion.available,
      version: daemonVersion.version,
      composeVersion,
      error: daemonVersion.error,
    },
    detection,
    configError,
    services,
    containers,
    image,
    dockerfilePorts,
    foreignStacks,
    hosts,
    activeOperationId: activeOperationId ?? null,
    fetchedAt: new Date().toISOString(),
  }
}

// --- operations -----------------------------------------------------------

/**
 * Confirms `containerId` actually belongs to this scope before anything
 * streams its logs — without this, the logs route would read any container
 * on the box given nothing but a hex id. A container is "ours" if it carries
 * either label `-p`/`docker run --label` would have stamped: the compose
 * label for a stack container (already scope-specific, since the compose
 * project name is), or the plain-Dockerfile label plus the `com.agentoo.session`
 * label matching this scope (present with this scope's session id at worktree
 * scope, absent entirely at repo scope) — see containers.ts's own
 * `listScopeContainers` for why a label check replaced a name comparison
 * here: a name can be forged by a colliding slug or simply not match a
 * container that was renamed after the fact, but `com.agentoo.session` is a
 * label only this feature itself ever sets.
 */
export async function containerBelongsToScope(
  projectId: string,
  sessionId: string | undefined,
  containerId: string,
  cli: DockerCli = realDockerCli,
): Promise<boolean> {
  const scope = await resolveDockerScope(projectId, sessionId) // 404s / 400s / 409s
  const identity = await containerIdentity(containerId, cli)
  if (!identity) return false
  if (identity.labels['com.docker.compose.project'] === composeProjectName(scope)) return true
  if (identity.labels['com.agentoo.project'] !== scope.slug) return false
  const session = identity.labels['com.agentoo.session']
  return scope.sessionId === null ? session === undefined : session === scope.sessionId
}

export async function listDockerOperations(projectId: string): Promise<DockerOperationDto[]> {
  await getProject(projectId) // 404s
  return listOperationsForProject(projectId)
}

export async function getDockerOperation(
  projectId: string,
  operationId: string,
): Promise<DockerOperationDto> {
  await getProject(projectId) // 404s
  const operation = await getOperation(operationId)
  if (!operation || operation.projectId !== projectId) {
    throw notFound('Docker operation')
  }
  return operation
}

/** What a Dockerfile-mode `up` runs with, resolved before dispatch — never
 * guessed at silently, per the brief: a port neither EXPOSE nor the built
 * image declares is a 400 naming the field the UI should ask for. */
async function resolveRunPort(
  scope: DockerScope,
  dockerfileAbsPath: string,
  explicit: number | undefined,
  cli: DockerCli,
): Promise<{ containerPort: number; protocol: 'tcp' | 'udp' }> {
  if (explicit !== undefined) return { containerPort: explicit, protocol: 'tcp' }

  const image = await inspectImage(imageReference(scope), cli)
  const fromImage = image.exists ? image.exposedPorts[0] : undefined
  if (fromImage) return { containerPort: fromImage.containerPort, protocol: fromImage.protocol }

  const text = await readFile(dockerfileAbsPath, 'utf8').catch(() => '')
  const fromDockerfile = parseExposedPorts(text)[0]
  if (fromDockerfile) {
    return { containerPort: fromDockerfile.containerPort, protocol: fromDockerfile.protocol }
  }

  throw badRequest(
    'This Dockerfile declares no EXPOSE and no image has been built yet; specify containerPort explicitly.',
  )
}

/** Commands suggested in a 503 when docker itself is the problem — not a
 * fix we can apply, only the two things an operator checks first. */
const DAEMON_RECOVERY_COMMANDS = ['sudo systemctl status docker', 'sudo systemctl start docker']
const CLI_MISSING_RECOVERY_COMMANDS = [
  '# docker is not installed on this host',
  'curl -fsSL https://get.docker.com | sudo sh',
]

interface OperationRequest {
  services?: string[]
  build?: boolean
  forceRecreate?: boolean
  removeOrphans?: boolean
  removeVolumes?: boolean
  removeImages?: boolean
  containerPort?: number
  hostPort?: number
}

async function requestOperation(
  projectId: string,
  sessionId: string | undefined,
  kind: DockerOperationKind,
  input: OperationRequest,
  cli: DockerCli,
): Promise<DockerOperationDto> {
  // Cheapest check first: a disabled feature answers 403 before this project
  // (or session) is even looked up.
  if (!env.DOCKER_ENABLED) throw forbidden('Docker controls are disabled (DOCKER_ENABLED=false)')

  const scope = await resolveDockerScope(projectId, sessionId) // 404s / 400s / 409s
  const detection = await detectProjectDocker(scope.path)

  if (!detection.hasCompose && !detection.hasDockerfile) {
    throw badRequest('No Dockerfile or compose file detected in this project')
  }

  // Decided here, not specified by the brief: a project can have both a
  // compose file and a standalone Dockerfile (compose services often build
  // from one), and compose is the more complete definition of "how this
  // project runs" — so it takes precedence whenever both are present.
  const mode: 'compose' | 'dockerfile' = detection.hasCompose ? 'compose' : 'dockerfile'
  const services = input.services ?? []

  if (mode === 'compose' && (input.containerPort !== undefined || input.hostPort !== undefined)) {
    throw badRequest('containerPort and hostPort only apply to a plain-Dockerfile project')
  }
  if (mode === 'dockerfile' && services.length > 0) {
    throw badRequest('services selection only applies to a compose project')
  }

  const lockScope = dockerLockScope(scope.projectId, scope.sessionId)
  const existing = await activeOperationForScope(lockScope)
  if (existing) {
    throw conflict(`Another docker operation (${existing}) is already running for this project`)
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

  let composeFiles: ComposeFiles | undefined
  let composeName: string | undefined
  if (mode === 'compose' && detection.composeFile) {
    composeName = composeProjectName(scope)
    composeFiles = {
      base: resolveDetected(scope.path, detection.composeFile),
      override: detection.composeOverrideFile
        ? resolveDetected(scope.path, detection.composeOverrideFile)
        : undefined,
    }

    if (services.length > 0) {
      const run = { cwd: scope.path, env: composeEnvFor(scope) }
      const config = await getComposeConfig(composeName, composeFiles, run, cli)
      if (config.ok || config.services.length > 0) {
        // Either the JSON form resolved cleanly, or it failed but the
        // names-only fallback still knows the service list (a Compose too
        // old for `config --format json`, most commonly) — either way there
        // is a real list to check the request against, and refusing it
        // anyway would make every per-service control dead on such a host
        // for no reason: the worker's own `docker compose` invocation does
        // not go through this parse at all.
        const known = new Set(config.services.map((s) => s.name))
        for (const name of services) {
          if (!known.has(name)) throw badRequest(`Unknown service: ${name}`)
        }
      } else if (kind === 'stop' || kind === 'down') {
        // Neither read produced a service list at all — most likely a
        // genuinely broken compose file. `dockerStateSchema.configError`'s
        // own contract is that stop/down stay usable even when start/restart
        // do not, so a named stop/down falls back to the one source of truth
        // that does not need the file to parse: the daemon's own view of
        // what is actually running, via the labels `-p` already stamped on
        // it. up/restart have no such fallback — they need a working config
        // to do anything meaningful — and stay refused below.
        const ids = await listContainerIds(composeProjectLabelFilter(scope), cli)
        const running = await inspectContainers(ids, cli)
        const knownFromDaemon = new Set(
          running.map((c) => c.service).filter((s): s is string => s !== null),
        )
        for (const name of services) {
          if (!knownFromDaemon.has(name)) throw badRequest(`Unknown service: ${name}`)
        }
      } else {
        throw badRequest(
          `Cannot validate the requested services: compose config failed: ${config.configError}`,
        )
      }
    }
  }

  let dockerfileAbsPath: string | undefined
  let containerPort: number | undefined
  let protocol: 'tcp' | 'udp' | undefined
  if (mode === 'dockerfile' && detection.dockerfile) {
    dockerfileAbsPath = resolveDetected(scope.path, detection.dockerfile)
    if (kind === 'up') {
      const resolved = await resolveRunPort(scope, dockerfileAbsPath, input.containerPort, cli)
      containerPort = resolved.containerPort
      protocol = resolved.protocol
    }
  }

  const operationId = randomUUID()
  const record = await createOperation({
    id: operationId,
    projectId,
    sessionId: scope.sessionId,
    kind,
    services,
  })

  const job: DockerOpJob = {
    operationId,
    projectId,
    sessionId: scope.sessionId,
    slug: scope.slug,
    mode,
    kind,
    services,
    // The directory this operation's -f/-f/build context resolve against —
    // the project's repo/ checkout at repo scope, a session's own worktree
    // once one is in play (see scope.ts).
    projectPath: scope.path,
    composeProjectName: composeName,
    composeFiles,
    build: input.build,
    forceRecreate: input.forceRecreate,
    removeOrphans: input.removeOrphans,
    removeVolumes: input.removeVolumes,
    removeImages: input.removeImages,
    dockerfileAbsPath,
    containerPort,
    hostPort: input.hostPort,
    protocol,
  }

  try {
    await enqueueDockerOp(job)
  } catch (error) {
    // The record already exists in Redis (createOperation above); leaving it
    // 'queued' forever with nothing to ever run it would be worse than saying
    // plainly that queueing itself failed.
    const message = error instanceof Error ? error.message : String(error)
    await finishOperation(operationId, 'failed', null, `Could not queue the operation: ${message}`)
    throw error
  }

  logger.info(`Docker ${kind} queued for project ${scope.slug} (operation ${operationId})`)
  return record
}

export async function requestDockerUp(
  projectId: string,
  sessionId: string | undefined,
  input: UpRequestInput,
  cli: DockerCli = realDockerCli,
): Promise<DockerOperationDto> {
  return requestOperation(projectId, sessionId, 'up', input, cli)
}

export async function requestDockerStop(
  projectId: string,
  sessionId: string | undefined,
  input: ServiceSelectionInput,
  cli: DockerCli = realDockerCli,
): Promise<DockerOperationDto> {
  return requestOperation(projectId, sessionId, 'stop', input, cli)
}

export async function requestDockerRestart(
  projectId: string,
  sessionId: string | undefined,
  input: ServiceSelectionInput,
  cli: DockerCli = realDockerCli,
): Promise<DockerOperationDto> {
  return requestOperation(projectId, sessionId, 'restart', input, cli)
}

export async function requestDockerDown(
  projectId: string,
  sessionId: string | undefined,
  input: DownRequestInput,
  cli: DockerCli = realDockerCli,
): Promise<DockerOperationDto> {
  return requestOperation(projectId, sessionId, 'down', input, cli)
}
