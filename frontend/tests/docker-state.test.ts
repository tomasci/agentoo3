// Pure helpers only — no DOM, no network. The generated `DockerStatus` shape
// is large, so `baseStatus` fills every required field with an inert default
// and each test overrides only what it is actually about.

import { expect, test } from 'bun:test'
import {
  CONTAINER_STATE_TONE,
  type DockerContainer,
  type DockerStatus,
  formatBoundPort,
  formatDeclaredComposePort,
  formatExposedPort,
  hasDockerConfig,
  isComposeProject,
  isOperationConflict,
  needsExplicitContainerPort,
  runningContainers,
  SERVICE_STATE_TONE,
  serviceRows,
} from '../src/features/docker/lib/state'

const container = (o: Partial<DockerContainer> & { id: string }): DockerContainer => ({
  shortId: o.id.slice(0, 12),
  name: o.id,
  service: null,
  image: 'app:latest',
  state: 'running',
  health: 'none',
  exitCode: null,
  createdAt: '2026-09-04T10:00:00.000Z',
  startedAt: '2026-09-04T10:00:01.000Z',
  finishedAt: null,
  ports: [],
  ...o,
})

const baseStatus = (o: Partial<DockerStatus> = {}): DockerStatus => ({
  projectId: 'p1',
  sessionId: null,
  projectPath: '/srv/p1',
  scopePath: '/srv/p1',
  composeProject: null,
  daemon: { cliInstalled: true, available: true, version: '27.0.0', composeVersion: '2.29.0', error: null },
  detection: {
    hasCompose: false,
    hasDockerfile: true,
    composeFile: null,
    composeOverrideFile: null,
    dockerfile: 'Dockerfile',
  },
  configError: null,
  services: [],
  containers: [],
  image: null,
  dockerfilePorts: [],
  foreignStacks: [],
  hosts: [],
  activeOperationId: null,
  fetchedAt: '2026-09-04T10:00:00.000Z',
  ...o,
})

// --- hasDockerConfig / isComposeProject ---------------------------------------

test('hasDockerConfig is false when neither compose nor a Dockerfile was found', () => {
  const status = baseStatus({
    detection: {
      hasCompose: false,
      hasDockerfile: false,
      composeFile: null,
      composeOverrideFile: null,
      dockerfile: null,
    },
  })
  expect(hasDockerConfig(status.detection)).toBe(false)
})

test('hasDockerConfig is true when only a Dockerfile was found', () => {
  const status = baseStatus()
  expect(hasDockerConfig(status.detection)).toBe(true)
  expect(isComposeProject(status)).toBe(false)
})

test('hasDockerConfig is true when only compose was found', () => {
  const status = baseStatus({
    detection: {
      hasCompose: true,
      hasDockerfile: false,
      composeFile: 'docker-compose.yml',
      composeOverrideFile: null,
      dockerfile: null,
    },
  })
  expect(hasDockerConfig(status.detection)).toBe(true)
  expect(isComposeProject(status)).toBe(true)
})

// --- needsExplicitContainerPort ------------------------------------------------

test('a compose project never needs an explicit port, regardless of dockerfilePorts/image', () => {
  const status = baseStatus({
    detection: {
      hasCompose: true,
      hasDockerfile: false,
      composeFile: 'docker-compose.yml',
      composeOverrideFile: null,
      dockerfile: null,
    },
    dockerfilePorts: [],
    image: null,
  })
  expect(needsExplicitContainerPort(status)).toBe(false)
})

test('a plain-Dockerfile project needs no port when the Dockerfile itself declares one', () => {
  const status = baseStatus({ dockerfilePorts: [{ containerPort: 8080, protocol: 'tcp' }] })
  expect(needsExplicitContainerPort(status)).toBe(false)
})

test('a plain-Dockerfile project needs no port when the built image declares one', () => {
  const status = baseStatus({
    image: { reference: 'app:latest', exists: true, builtAt: null, exposedPorts: [{ containerPort: 3000, protocol: 'tcp' }] },
  })
  expect(needsExplicitContainerPort(status)).toBe(false)
})

test('a plain-Dockerfile project needs an explicit port when nothing declares one at all', () => {
  const status = baseStatus({ dockerfilePorts: [], image: null })
  expect(needsExplicitContainerPort(status)).toBe(true)
})

test('a plain-Dockerfile project needs an explicit port when the image exists but declares none', () => {
  const status = baseStatus({
    image: { reference: 'app:latest', exists: true, builtAt: null, exposedPorts: [] },
  })
  expect(needsExplicitContainerPort(status)).toBe(true)
})

// --- serviceRows ----------------------------------------------------------------

test('a compose project gets one row per service, each with only its own containers', () => {
  const web = container({ id: 'web1', service: 'web', state: 'running' })
  const db = container({ id: 'db1', service: 'db', state: 'exited' })
  const status = baseStatus({
    detection: {
      hasCompose: true,
      hasDockerfile: false,
      composeFile: 'docker-compose.yml',
      composeOverrideFile: null,
      dockerfile: null,
    },
    services: [
      { name: 'web', image: 'web:latest', build: false, profiles: [], dependsOn: [], declaredPorts: [], containerIds: ['web1'], state: 'running' },
      { name: 'db', image: 'db:latest', build: false, profiles: [], dependsOn: [], declaredPorts: [], containerIds: ['db1'], state: 'stopped' },
    ],
    containers: [web, db],
  })

  const rows = serviceRows(status)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual({ service: 'web', state: 'running', containers: [web], declaredPorts: [] })
  expect(rows[1]).toEqual({ service: 'db', state: 'stopped', containers: [db], declaredPorts: [] })
})

test('a plain-Dockerfile project with no container yet gets one absent row', () => {
  const status = baseStatus({ containers: [] })
  expect(serviceRows(status)).toEqual([{ service: null, state: 'absent', containers: [], declaredPorts: [] }])
})

test('a plain-Dockerfile project with only a stopped container gets one stopped row, not partial', () => {
  // `partial` is a compose-only notion (some of several containers running);
  // there is exactly one container on this path, so "exists but not
  // running" reads as `stopped` — the regression this pins is the tone that
  // came with the wrong word: `stopped` is neutral, `partial` is a warning
  // amber, which painted a cleanly stopped container as though something
  // were wrong.
  const exited = container({ id: 'app1', state: 'exited' })
  const status = baseStatus({ containers: [exited] })
  expect(serviceRows(status)).toEqual([
    { service: null, state: 'stopped', containers: [exited], declaredPorts: [] },
  ])
})

test('a plain-Dockerfile project with a running container gets one running row', () => {
  const running = container({ id: 'app1', state: 'running' })
  const status = baseStatus({ containers: [running] })
  expect(serviceRows(status)).toEqual([
    { service: null, state: 'running', containers: [running], declaredPorts: [] },
  ])
})

// --- runningContainers ------------------------------------------------------------

test('runningContainers keeps only state running, across every service', () => {
  const a = container({ id: 'a', state: 'running' })
  const b = container({ id: 'b', state: 'exited' })
  const c = container({ id: 'c', state: 'running' })
  const status = baseStatus({ containers: [a, b, c] })
  expect(runningContainers(status)).toEqual([a, c])
})

// --- port formatting ---------------------------------------------------------------

test('formatBoundPort renders host:port to container port/protocol', () => {
  expect(formatBoundPort({ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 })).toBe(
    '0.0.0.0:8080 → 80/tcp',
  )
})

test('formatDeclaredComposePort prefers a published range when one exists', () => {
  expect(
    formatDeclaredComposePort({
      containerPort: 80,
      publishedPort: null,
      publishedRange: '8080-8090',
      protocol: 'tcp',
      hostIp: null,
    }),
  ).toBe('8080-8090 → 80/tcp')
})

test('formatDeclaredComposePort falls back to a fixed published port', () => {
  expect(
    formatDeclaredComposePort({
      containerPort: 80,
      publishedPort: 8080,
      publishedRange: null,
      protocol: 'tcp',
      hostIp: null,
    }),
  ).toBe('8080 → 80/tcp')
})

test('formatDeclaredComposePort shows "?" when compose exposes a port with no host side at all', () => {
  expect(
    formatDeclaredComposePort({
      containerPort: 80,
      publishedPort: null,
      publishedRange: null,
      protocol: 'tcp',
      hostIp: null,
    }),
  ).toBe('? → 80/tcp')
})

test('formatExposedPort renders container-port/protocol only', () => {
  expect(formatExposedPort({ containerPort: 3000, protocol: 'tcp' })).toBe('3000/tcp')
})

// --- isOperationConflict -------------------------------------------------------------

test('isOperationConflict is true only for a 409 response', () => {
  expect(isOperationConflict({ response: { status: 409 } })).toBe(true)
  expect(isOperationConflict({ response: { status: 400 } })).toBe(false)
  expect(isOperationConflict({ response: { status: 503 } })).toBe(false)
  expect(isOperationConflict(new Error('network down'))).toBe(false)
  expect(isOperationConflict(undefined)).toBe(false)
  expect(isOperationConflict(null)).toBe(false)
})

// --- tone maps: every real state has a real tone, none silently blank -----------------

test('every service/container state maps to a real tone', () => {
  for (const tone of Object.values(SERVICE_STATE_TONE)) expect(typeof tone).toBe('string')
  for (const tone of Object.values(CONTAINER_STATE_TONE)) expect(typeof tone).toBe('string')
  expect(CONTAINER_STATE_TONE.dead).toBe('danger')
  expect(CONTAINER_STATE_TONE.running).toBe('success')
  expect(SERVICE_STATE_TONE.running).toBe('success')
  expect(SERVICE_STATE_TONE.absent).toBe('neutral')
})
