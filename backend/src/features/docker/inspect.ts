// Parsing for `docker ps`, `docker inspect` and `docker version` output.
//
// None of these shapes could be verified against a real daemon — there is
// none on this host — so every zod schema here is deliberately tolerant:
// unknown extra fields are allowed, optional fields default to absent rather
// than failing the parse, and a shape this module has never seen degrades to
// a warning and an empty/absent result rather than a 500. See the feature's
// own docker-inspect.test.ts for the exact NDJSON shapes this is built
// against.

import { z } from 'zod'
import { logger } from '@/lib/logger'
import { imageInspectArgs, psFilterArgs, versionArgs } from './args'
import {
  DOCKER_READ_TIMEOUT_MS,
  type DockerCli,
  MISSING_BINARY_EXIT_CODE,
  realDockerCli,
} from './cli'
import type { DockerPort } from './dockerfile'

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// --- docker ps -aq --filter ------------------------------------------------

/** Bare ids, one per line, possibly empty. */
export async function listContainerIds(
  filter: string,
  cli: DockerCli = realDockerCli,
): Promise<string[]> {
  const result = await cli.run(psFilterArgs(filter), { timeoutMs: DOCKER_READ_TIMEOUT_MS })
  if (!result.ok) return []
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// --- docker inspect --type container ----------------------------------------

// Every field below `Id` is wrapped in its own `.catch(undefined)`, not just
// `.optional()`: `.optional()` only tolerates a field being *absent*, and a
// single unexpected field anywhere in one container's JSON — a type docker
// changed, a value this module has never seen — used to fail the *entire*
// object's `safeParse` and drop that container from `containers[]`
// outright, which reads on the dashboard as a running container silently
// vanishing (and its service reading `absent`). `.catch()` degrades at the
// granularity that actually matters: the one field that did not parse is
// missing, every other field this container legitimately reported is kept.
// `Id` alone stays a hard requirement — with no id there is nothing to
// correlate this record to a container by at all.
const portBindingRaw = z
  .object({
    HostIp: z.string().optional().catch(undefined),
    HostPort: z.string().optional().catch(undefined),
  })
  .passthrough()

const containerInspectRaw = z
  .object({
    Id: z.string(),
    Name: z.string().optional().catch(undefined),
    Image: z.string().optional().catch(undefined),
    Config: z
      .object({
        Image: z.string().optional().catch(undefined),
        Labels: z.record(z.string(), z.string()).nullable().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    State: z
      .object({
        Status: z.string().optional().catch(undefined),
        Health: z
          .object({ Status: z.string().optional().catch(undefined) })
          .passthrough()
          .optional()
          .catch(undefined),
        ExitCode: z.number().optional().catch(undefined),
        StartedAt: z.string().optional().catch(undefined),
        FinishedAt: z.string().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    Created: z.string().optional().catch(undefined),
    // `null` for a container with no published or exposed ports at all; a
    // per-port value inside it is `null` too for "exposed but not published".
    NetworkSettings: z
      .object({
        Ports: z
          .record(z.string(), z.array(portBindingRaw).nullable())
          .nullable()
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough()

export type ContainerInspectRaw = z.infer<typeof containerInspectRaw>

const CONTAINER_STATE_VALUES = [
  'created',
  'running',
  'restarting',
  'removing',
  'paused',
  'exited',
  'dead',
] as const
export type ContainerState = (typeof CONTAINER_STATE_VALUES)[number]
const CONTAINER_STATES: ReadonlySet<string> = new Set(CONTAINER_STATE_VALUES)

/** The zero time docker prints for StartedAt/FinishedAt when it never happened. */
const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z'

/**
 * NDJSON: one JSON object per line, not an array — `docker inspect` prints
 * each container inspected as its own top-level JSON value. A line that fails
 * to parse, or parses but does not match the shape above, is skipped with a
 * warning rather than discarding every container the call returned.
 */
export function parseContainerInspectNdjson(text: string): ContainerInspectRaw[] {
  const out: ContainerInspectRaw[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const json = safeJsonParse(line)
    if (json === undefined) {
      logger.warn('docker inspect emitted a line that was not valid JSON; skipping it')
      continue
    }
    const shaped = containerInspectRaw.safeParse(json)
    if (!shaped.success) {
      logger.warn(`docker inspect returned an unexpected container shape: ${shaped.error.message}`)
      continue
    }
    out.push(shaped.data)
  }
  return out
}

export interface PublishedPort {
  containerPort: number
  protocol: 'tcp' | 'udp'
  hostIp: string
  hostPort: number
}

export interface DockerContainer {
  id: string
  shortId: string
  name: string
  service: string | null
  image: string
  state: ContainerState
  health: 'healthy' | 'unhealthy' | 'starting' | 'none'
  exitCode: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  ports: PublishedPort[]
}

/** The label `docker compose -p <name>` stamps on every container it starts. */
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service'

export function toDockerContainer(raw: ContainerInspectRaw): DockerContainer {
  const status = raw.State?.Status
  const state: ContainerState =
    status && CONTAINER_STATES.has(status) ? (status as ContainerState) : 'dead'

  const health = raw.State?.Health?.Status
  const labels = raw.Config?.Labels ?? undefined

  const ports: PublishedPort[] = []
  for (const [key, bindings] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
    if (!bindings) continue // exposed but never published
    const [portText, protoText] = key.split('/')
    const containerPort = Number(portText)
    if (!Number.isInteger(containerPort)) continue
    for (const binding of bindings) {
      // An empty (or absent) HostPort is docker's shape for "declared but
      // not actually bound" on some engine versions — `Number('')` is `0`,
      // and `Number.isInteger(0)` is true, so this used to mint a
      // `hostPort: 0` entry that violates publishedPortSchema's own
      // `min(1)` and would render as a nonsense `http://host:0` access URL.
      if (!binding.HostPort) continue
      const hostPort = Number(binding.HostPort)
      if (!Number.isInteger(hostPort) || hostPort <= 0) continue
      ports.push({
        containerPort,
        protocol: protoText === 'udp' ? 'udp' : 'tcp',
        hostIp: binding.HostIp || '0.0.0.0',
        hostPort,
      })
    }
  }

  const startedAt =
    raw.State?.StartedAt && raw.State.StartedAt !== DOCKER_ZERO_TIME ? raw.State.StartedAt : null
  const finishedAt =
    raw.State?.FinishedAt && raw.State.FinishedAt !== DOCKER_ZERO_TIME ? raw.State.FinishedAt : null

  return {
    id: raw.Id,
    shortId: raw.Id.slice(0, 12),
    name: (raw.Name ?? '').replace(/^\//, ''),
    service: labels?.[COMPOSE_SERVICE_LABEL] ?? null,
    image: raw.Config?.Image ?? raw.Image ?? '',
    state,
    health:
      health === 'healthy' || health === 'unhealthy' || health === 'starting' ? health : 'none',
    exitCode: typeof raw.State?.ExitCode === 'number' ? raw.State.ExitCode : null,
    createdAt: raw.Created ?? '',
    startedAt,
    finishedAt,
    ports,
  }
}

/**
 * Raw label lookup for one container — used only for the ownership check
 * `GET .../containers/{containerId}/logs` needs before it will stream
 * anything. Deliberately separate from `toDockerContainer` above: the public
 * DTO only ever exposes the *derived* `service` name, never the raw
 * `com.docker.compose.project`/`com.agentoo.project` labels this check reads.
 */
export async function containerLabels(
  containerId: string,
  cli: DockerCli = realDockerCli,
): Promise<Record<string, string> | undefined> {
  const result = await cli.run(
    ['inspect', '--type', 'container', '--format', '{{json .}}', containerId],
    { timeoutMs: DOCKER_READ_TIMEOUT_MS },
  )
  if (!result.ok) return undefined
  const [raw] = parseContainerInspectNdjson(result.stdout)
  return raw?.Config?.Labels ?? undefined
}

export async function inspectContainers(
  containerIds: string[],
  cli: DockerCli = realDockerCli,
): Promise<DockerContainer[]> {
  if (containerIds.length === 0) return []
  const result = await cli.run(
    ['inspect', '--type', 'container', '--format', '{{json .}}', ...containerIds.slice(0, 200)],
    { timeoutMs: DOCKER_READ_TIMEOUT_MS },
  )
  if (!result.ok) return []
  return parseContainerInspectNdjson(result.stdout).map(toDockerContainer)
}

// --- docker image inspect ----------------------------------------------------

const imageInspectRaw = z
  .object({
    Created: z.string().optional(),
    Config: z
      .object({ ExposedPorts: z.record(z.string(), z.unknown()).nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

export interface DockerImage {
  exists: boolean
  builtAt: string | null
  exposedPorts: DockerPort[]
}

export async function inspectImage(
  reference: string,
  cli: DockerCli = realDockerCli,
): Promise<DockerImage> {
  const result = await cli.run(imageInspectArgs(reference), { timeoutMs: DOCKER_READ_TIMEOUT_MS })
  if (!result.ok) return { exists: false, builtAt: null, exposedPorts: [] }

  const json = safeJsonParse(result.stdout.split('\n')[0] ?? '')
  const shaped = imageInspectRaw.safeParse(json)
  if (!shaped.success) {
    logger.warn(`docker image inspect returned an unexpected shape: ${shaped.error.message}`)
    return { exists: false, builtAt: null, exposedPorts: [] }
  }

  const exposedPorts: DockerPort[] = []
  for (const key of Object.keys(shaped.data.Config?.ExposedPorts ?? {})) {
    const [portText, protoText] = key.split('/')
    const containerPort = Number(portText)
    if (!Number.isInteger(containerPort)) continue
    exposedPorts.push({ containerPort, protocol: protoText === 'udp' ? 'udp' : 'tcp' })
  }

  return { exists: true, builtAt: shaped.data.Created ?? null, exposedPorts }
}

// --- docker version -----------------------------------------------------------

const versionRaw = z
  .object({
    Client: z.object({ Version: z.string().optional() }).passthrough().optional(),
    Server: z.object({ Version: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()

export interface DaemonVersion {
  cliInstalled: boolean
  /** True only once the daemon itself answered — `Server` present in a
   * successful `docker version`, not merely that the binary ran. */
  available: boolean
  version: string | null
  error: string | null
}

export async function getDaemonVersion(cli: DockerCli = realDockerCli): Promise<DaemonVersion> {
  const result = await cli.run(versionArgs(), { timeoutMs: DOCKER_READ_TIMEOUT_MS })
  if (result.exitCode === MISSING_BINARY_EXIT_CODE) {
    return { cliInstalled: false, available: false, version: null, error: null }
  }

  const shaped = versionRaw.safeParse(safeJsonParse(result.stdout))
  const clientVersion = shaped.success ? (shaped.data.Client?.Version ?? null) : null
  // With the daemon down, `docker version` exits non-zero and `Server` is
  // simply absent from otherwise-valid JSON — that is expected, not a parse
  // failure, so it is read here rather than folded into the warn-and-degrade
  // path above.
  const serverPresent = shaped.success && shaped.data.Server !== undefined

  return {
    cliInstalled: true,
    available: result.ok && serverPresent,
    version: clientVersion,
    error: result.ok ? null : (result.stderr || 'docker version failed').slice(0, 2000),
  }
}
