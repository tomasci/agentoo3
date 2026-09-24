import type { GetApiProjectsIdDockerStatus200 } from '@/shared/api/generated/types/GetApiProjectsIdDocker'
import type { Tone } from '@/shared/components'

export type DockerStatus = GetApiProjectsIdDockerStatus200
export type DockerDetection = DockerStatus['detection']
export type DockerService = DockerStatus['services'][number]
export type DockerContainer = DockerStatus['containers'][number]
export type ServiceState = DockerService['state']
export type ContainerState = DockerContainer['state']
export type ContainerHealth = DockerContainer['health']
export type BoundPort = DockerContainer['ports'][number]
export type DeclaredComposePort = DockerService['declaredPorts'][number]
export type ExposedPort = { containerPort: number; protocol: string }

/**
 * One row per compose service, or the one synthetic row a plain-Dockerfile
 * project gets — `service: null` is what marks that case everywhere else in
 * this feature reads a row, rather than every caller re-deriving "is this
 * the Dockerfile path" from `status.detection` on its own.
 */
export interface ServiceRow {
  service: string | null
  state: ServiceState
  containers: DockerContainer[]
  declaredPorts: DeclaredComposePort[]
}

// `Record<Union, Tone>` fails the build if the backend ever adds a state this
// has not been given a tone for — the same exhaustive-map idiom
// `status-dot.tsx`'s own `TONE` record uses.
export const SERVICE_STATE_TONE: Record<ServiceState, Tone> = {
  running: 'success',
  partial: 'warning',
  stopped: 'neutral',
  absent: 'neutral',
}

export const CONTAINER_STATE_TONE: Record<ContainerState, Tone> = {
  created: 'neutral',
  running: 'success',
  restarting: 'warning',
  removing: 'warning',
  paused: 'warning',
  exited: 'neutral',
  dead: 'danger',
}

export const CONTAINER_HEALTH_TONE: Record<ContainerHealth, Tone> = {
  healthy: 'success',
  unhealthy: 'danger',
  starting: 'warning',
  none: 'neutral',
}

/** Whether detection found anything worth showing run controls for at all —
 * the gate between the empty state and the rest of this page. */
export function hasDockerConfig(detection: DockerDetection): boolean {
  return detection.hasCompose || detection.hasDockerfile
}

export function isComposeProject(status: DockerStatus): boolean {
  return status.detection.hasCompose
}

/**
 * The plain-Dockerfile path only: true when neither the built image's own
 * `EXPOSE` metadata nor a Dockerfile `EXPOSE` line names a port, which is
 * exactly the case the server refuses to guess for and 400s on `up` without
 * an explicit `containerPort` in the request body.
 */
export function needsExplicitContainerPort(status: DockerStatus): boolean {
  return (
    !isComposeProject(status) &&
    status.dockerfilePorts.length === 0 &&
    (status.image?.exposedPorts.length ?? 0) === 0
  )
}

/**
 * One row per compose service (real backend state), or the single synthetic
 * row standing in for a plain-Dockerfile project's one container — `state`
 * for that row is derived here, since the server only reports per-service
 * state for compose projects (`services[]` is empty otherwise).
 */
export function serviceRows(status: DockerStatus): ServiceRow[] {
  if (isComposeProject(status)) {
    return status.services.map((service) => ({
      service: service.name,
      state: service.state,
      containers: status.containers.filter((c) => c.service === service.name),
      declaredPorts: service.declaredPorts,
    }))
  }

  const containers = status.containers
  // `partial` is a compose notion — some of a service's several containers
  // running, some not. There is exactly one container on this path, so
  // "exists but not running" is `stopped`, never `partial`: that word's own
  // tone (SERVICE_STATE_TONE.partial = 'warning') would paint a cleanly
  // stopped container amber, as though something were wrong.
  const state: ServiceState = containers.some((c) => c.state === 'running')
    ? 'running'
    : containers.length > 0
      ? 'stopped'
      : 'absent'
  return [{ service: null, state, containers, declaredPorts: [] }]
}

export function runningContainers(status: DockerStatus): DockerContainer[] {
  return status.containers.filter((c) => c.state === 'running')
}

/** A real, currently-bound port — what actually reaches this container right
 * now, as opposed to what compose/the Dockerfile merely declares. */
export function formatBoundPort(port: BoundPort): string {
  return `${port.hostIp}:${port.hostPort} → ${port.containerPort}/${port.protocol}`
}

/** A compose service's declared port, before anything has necessarily
 * published it — `publishedPort`/`publishedRange` are both nullable (compose
 * lets a port be exposed without choosing a host side at all). */
export function formatDeclaredComposePort(port: DeclaredComposePort): string {
  const published =
    port.publishedRange ?? (port.publishedPort != null ? String(port.publishedPort) : '?')
  return `${published} → ${port.containerPort}/${port.protocol}`
}

/** A Dockerfile `EXPOSE` line or a built image's own exposed-ports metadata —
 * the plain-Dockerfile path's equivalent of a declared compose port. */
export function formatExposedPort(port: ExposedPort): string {
  return `${port.containerPort}/${port.protocol}`
}

/** True for a 409: another operation is already running for this project.
 * Kept separate from `apiErrorMessage` so a caller can choose the fixed,
 * translated copy the brief asks for while still preferring whatever more
 * specific text the backend sent (it "names" the operation in conflict). */
export function isOperationConflict(error: unknown): boolean {
  return (error as { response?: { status?: number } } | undefined)?.response?.status === 409
}
