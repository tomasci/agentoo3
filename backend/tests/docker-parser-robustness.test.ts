// Independent verification pass over the docker output parsers.
//
// None of these shapes can be observed on this host (no docker daemon, no
// docker binary), so they are reconstructed from docker's documented output
// and from the shapes the implementation's own comments claim to handle. The
// property under test throughout is degradation: a surprising line, a null
// where an object was expected, a string where a number was expected must
// yield an empty/partial result and a log line, never a throw that would
// become a 500 on GET /projects/{id}/docker.
//
// Pure parsers plus a fake DockerCli — nothing here imports a module that
// reaches Redis, Postgres or the queue, so this file registers no
// `mock.module` at all and cannot perturb any other file in the shared test
// process.

import { expect, test } from 'bun:test'
import type { DockerCli, DockerResult, DockerStream } from '../src/features/docker/cli'
import {
  foreignStacksFor,
  getComposeConfig,
  getComposeVersion,
} from '../src/features/docker/compose-config'
import { parseExposedPorts } from '../src/features/docker/dockerfile'
import {
  getDaemonVersion,
  inspectImage,
  parseContainerInspectNdjson,
  toDockerContainer,
} from '../src/features/docker/inspect'

const ok = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, exitCode = 1): DockerResult => ({
  ok: false,
  stdout: '',
  stderr,
  exitCode,
})

function cliReturning(result: (args: string[]) => DockerResult): DockerCli {
  return {
    async run(args) {
      return result(args)
    },
    stream(): DockerStream {
      throw new Error('stream() is not used in this file')
    },
  }
}

const ID = 'f'.repeat(64)
const line = (o: Record<string, unknown>) => JSON.stringify({ Id: ID, ...o })

// --- docker inspect: shapes the DTO has to survive --------------------------

test('a port that is exposed but unpublished (null bindings) yields no published port', () => {
  const [raw] = parseContainerInspectNdjson(line({ NetworkSettings: { Ports: { '80/tcp': null } } }))
  expect(raw).toBeDefined()
  expect(toDockerContainer(raw!).ports).toEqual([])
})

test('an empty bindings array is not mistaken for a binding', () => {
  const [raw] = parseContainerInspectNdjson(line({ NetworkSettings: { Ports: { '80/tcp': [] } } }))
  expect(toDockerContainer(raw!).ports).toEqual([])
})

test('HostPort arrives as a string and is read back as a number', () => {
  const [raw] = parseContainerInspectNdjson(
    line({
      NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '32768' }] } },
    }),
  )
  expect(toDockerContainer(raw!).ports).toEqual([
    { containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 32768 },
  ])
})

test('an IPv6 and an IPv4 binding for one port are both reported', () => {
  const [raw] = parseContainerInspectNdjson(
    line({
      NetworkSettings: {
        Ports: {
          '80/tcp': [
            { HostIp: '0.0.0.0', HostPort: '8080' },
            { HostIp: '::', HostPort: '8080' },
          ],
        },
      },
    }),
  )
  expect(toDockerContainer(raw!).ports).toHaveLength(2)
})

test('a udp port key keeps its protocol', () => {
  const [raw] = parseContainerInspectNdjson(
    line({ NetworkSettings: { Ports: { '53/udp': [{ HostIp: '', HostPort: '5353' }] } } }),
  )
  const [port] = toDockerContainer(raw!).ports
  expect(port?.protocol).toBe('udp')
  // An empty HostIp is docker's "every interface"; the DTO must not carry ''.
  expect(port?.hostIp).toBe('0.0.0.0')
})

test('NetworkSettings.Ports being null degrades to no ports', () => {
  const [raw] = parseContainerInspectNdjson(line({ NetworkSettings: { Ports: null } }))
  expect(toDockerContainer(raw!).ports).toEqual([])
})

test('Config.Labels being null degrades to service: null, not a throw', () => {
  const [raw] = parseContainerInspectNdjson(line({ Config: { Image: 'nginx', Labels: null } }))
  const container = toDockerContainer(raw!)
  expect(container.service).toBeNull()
  expect(container.image).toBe('nginx')
})

test('State.Health absent maps to "none", not undefined', () => {
  const [raw] = parseContainerInspectNdjson(line({ State: { Status: 'running' } }))
  expect(toDockerContainer(raw!).health).toBe('none')
})

test('an unrecognised State.Status is reported as "dead" rather than leaking through', () => {
  const [raw] = parseContainerInspectNdjson(line({ State: { Status: 'wobbly' } }))
  expect(toDockerContainer(raw!).state).toBe('dead')
})

test('the zero timestamps docker prints for a never-started container become null', () => {
  const [raw] = parseContainerInspectNdjson(
    line({
      State: {
        Status: 'created',
        StartedAt: '0001-01-01T00:00:00Z',
        FinishedAt: '0001-01-01T00:00:00Z',
      },
    }),
  )
  const container = toDockerContainer(raw!)
  expect(container.startedAt).toBeNull()
  expect(container.finishedAt).toBeNull()
})

test('a truncated JSON line among valid ones costs only that line', () => {
  const text = `${line({ Name: '/a' })}\n{"Id": "deadbeef\n${line({ Id: 'b'.repeat(64) })}`
  const parsed = parseContainerInspectNdjson(text)
  expect(parsed).toHaveLength(2)
  expect(parsed.map((p) => p.Id)).toEqual([ID, 'b'.repeat(64)])
})

test('empty stdout parses to no containers rather than throwing', () => {
  expect(parseContainerInspectNdjson('')).toEqual([])
  expect(parseContainerInspectNdjson('   \n\n  ')).toEqual([])
})

test('a JSON line that is an array, not an object, is skipped', () => {
  expect(parseContainerInspectNdjson('[{"Id":"x"}]')).toEqual([])
})

// --- docker image inspect ----------------------------------------------------

test('image inspect with ExposedPorts null reports the image as built with no ports', async () => {
  const image = await inspectImage(
    'agentoo/demo:latest',
    cliReturning(() => ok(JSON.stringify({ Created: '2024-05-01T00:00:00Z', Config: { ExposedPorts: null } }))),
  )
  expect(image).toEqual({ exists: true, builtAt: '2024-05-01T00:00:00Z', exposedPorts: [] })
})

test('image inspect keeps udp exposed ports distinct from tcp', async () => {
  const image = await inspectImage(
    'agentoo/demo:latest',
    cliReturning(() => ok(JSON.stringify({ Config: { ExposedPorts: { '3000/tcp': {}, '53/udp': {} } } }))),
  )
  expect(image.exposedPorts).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 53, protocol: 'udp' },
  ])
  expect(image.builtAt).toBeNull()
})

test("a built image's ExposedPorts win over the Dockerfile's EXPOSE", async () => {
  // The precedence the state DTO documents. Both are read here the way
  // service.ts reads them; the assertion is that they are distinguishable and
  // that the image's value is the one a caller is told to prefer.
  const dockerfilePorts = parseExposedPorts('FROM x\nEXPOSE 3000\n')
  const image = await inspectImage(
    'agentoo/demo:latest',
    cliReturning(() => ok(JSON.stringify({ Config: { ExposedPorts: { '8080/tcp': {} } } }))),
  )
  expect(dockerfilePorts).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
  expect(image.exists).toBe(true)
  expect(image.exposedPorts).toEqual([{ containerPort: 8080, protocol: 'tcp' }])
})

// --- Dockerfile EXPOSE grammar ------------------------------------------------

test('EXPOSE survives CRLF line endings', () => {
  expect(parseExposedPorts('FROM x\r\nEXPOSE 8080\r\nCMD ["x"]\r\n')).toEqual([
    { containerPort: 8080, protocol: 'tcp' },
  ])
})

test('EXPOSE tolerates leading whitespace and a tab separator', () => {
  expect(parseExposedPorts('   EXPOSE\t3000')).toEqual([{ containerPort: 3000, protocol: 'tcp' }])
})

test('an inline comment after EXPOSE does not swallow the port', () => {
  expect(parseExposedPorts('EXPOSE 3000 # the app port')).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
  ])
})

test('port 0 is out of range and is skipped', () => {
  expect(parseExposedPorts('EXPOSE 0')).toEqual([])
})

test('a multi-stage Dockerfile collects every stage’s EXPOSE', () => {
  const text = 'FROM node AS build\nEXPOSE 3000\nFROM nginx\nEXPOSE 80\nEXPOSE 443/tcp\n'
  expect(parseExposedPorts(text)).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 80, protocol: 'tcp' },
    { containerPort: 443, protocol: 'tcp' },
  ])
})

test('an unresolved interpolation is skipped while its literal neighbour is kept', () => {
  expect(parseExposedPorts('EXPOSE ${PORT} 8080')).toEqual([{ containerPort: 8080, protocol: 'tcp' }])
})

// --- docker compose config --format json ------------------------------------

const composeCli = (payload: unknown) =>
  cliReturning((args) =>
    args.includes('--format') ? ok(JSON.stringify(payload)) : fail('unused fallback'),
  )

async function servicesOf(payload: unknown) {
  const result = await getComposeConfig(
    'agentoo-demo',
    { base: '/projects/demo/repo/compose.yaml' },
    '/projects/demo/repo',
    composeCli(payload),
  )
  return result
}

test('published as a string is read as a number, not dropped', async () => {
  const result = await servicesOf({
    services: { web: { ports: [{ target: 3000, published: '3000', protocol: 'tcp' }] } },
  })
  expect(result.ok).toBe(true)
  expect(result.services[0]?.declaredPorts).toEqual([
    {
      containerPort: 3000,
      publishedPort: 3000,
      publishedRange: null,
      protocol: 'tcp',
      hostIp: null,
    },
  ])
})

test('a published range string is kept as a range, never coerced to a single port', async () => {
  const result = await servicesOf({
    services: { web: { ports: [{ target: 3000, published: '3000-3005' }] } },
  })
  const [port] = result.services[0]?.declaredPorts ?? []
  expect(port?.publishedPort).toBeNull()
  expect(port?.publishedRange).toBe('3000-3005')
})

test('target as a number and as a string both resolve to the same container port', async () => {
  const asNumber = await servicesOf({ services: { web: { ports: [{ target: 8080 }] } } })
  const asString = await servicesOf({ services: { web: { ports: [{ target: '8080' }] } } })
  expect(asNumber.services[0]?.declaredPorts[0]?.containerPort).toBe(8080)
  expect(asString.services[0]?.declaredPorts[0]?.containerPort).toBe(8080)
})

test('a port entry with no target at all is dropped, not reported as NaN', async () => {
  const result = await servicesOf({ services: { web: { ports: [{ published: 3000 }] } } })
  expect(result.ok).toBe(true)
  expect(result.services[0]?.declaredPorts).toEqual([])
})

test('host_ip and protocol absent default to null host and tcp', async () => {
  const result = await servicesOf({ services: { web: { ports: [{ target: 5432 }] } } })
  expect(result.services[0]?.declaredPorts[0]).toEqual({
    containerPort: 5432,
    publishedPort: null,
    publishedRange: null,
    protocol: 'tcp',
    hostIp: null,
  })
})

test('depends_on as an object map and as an array both yield the same names', async () => {
  const asMap = await servicesOf({
    services: { web: { depends_on: { db: { condition: 'service_healthy' } } }, db: {} },
  })
  const asArray = await servicesOf({ services: { web: { depends_on: ['db'] }, db: {} } })
  expect(asMap.services[0]?.dependsOn).toEqual(['db'])
  expect(asArray.services[0]?.dependsOn).toEqual(['db'])
})

test('build as an object, as a string, and absent are distinguished', async () => {
  const result = await servicesOf({
    services: {
      a: { build: { context: '.', dockerfile: 'Dockerfile' } },
      b: { build: '.' },
      c: { image: 'nginx' },
    },
  })
  expect(result.services.map((s) => [s.name, s.build])).toEqual([
    ['a', true],
    ['b', true],
    ['c', false],
  ])
})

test('a service with no ports key at all has no declared ports', async () => {
  const result = await servicesOf({ services: { db: { image: 'postgres:16' } } })
  expect(result.services).toEqual([
    {
      name: 'db',
      image: 'postgres:16',
      build: false,
      profiles: [],
      dependsOn: [],
      declaredPorts: [],
    },
  ])
})

test('a config response that is not JSON at all degrades to configError, never a throw', async () => {
  const result = await getComposeConfig(
    'agentoo-demo',
    { base: '/projects/demo/repo/compose.yaml' },
    '/projects/demo/repo',
    cliReturning((args) => (args.includes('--format') ? ok('not json at all') : fail('nope'))),
  )
  expect(result.ok).toBe(false)
  expect(result.services).toEqual([])
  expect(result.configError).toBeTruthy()
})

// --- docker compose ls --format json ----------------------------------------

const LS_ARGS_MARKER = 'ls'

test('ConfigFiles is split on commas into separate paths', async () => {
  const base = '/projects/demo/repo/compose.yaml'
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    base,
    cliReturning((args) =>
      args.includes(LS_ARGS_MARKER)
        ? ok(
            JSON.stringify([
              {
                Name: 'repo',
                Status: 'running(2)',
                ConfigFiles: `${base},/projects/demo/repo/compose.override.yaml`,
              },
            ]),
          )
        : fail('unused'),
    ),
  )
  expect(stacks).toEqual([
    {
      name: 'repo',
      status: 'running(2)',
      configFiles: [base, '/projects/demo/repo/compose.override.yaml'],
    },
  ])
})

test('a stack whose ConfigFiles do not include ours is not reported', async () => {
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/projects/demo/repo/compose.yaml',
    cliReturning(() =>
      ok(JSON.stringify([{ Name: 'other', Status: 'running(1)', ConfigFiles: '/elsewhere/compose.yaml' }])),
    ),
  )
  expect(stacks).toEqual([])
})

test('compose ls failing is non-fatal and yields no foreign stacks', async () => {
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/projects/demo/repo/compose.yaml',
    cliReturning(() => fail('permission denied while trying to connect to the docker daemon')),
  )
  expect(stacks).toEqual([])
})

test('compose ls emitting a JSON object rather than an array is non-fatal', async () => {
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/projects/demo/repo/compose.yaml',
    cliReturning(() => ok('{"Name":"repo"}')),
  )
  expect(stacks).toEqual([])
})

test('compose ls with a null ConfigFiles entry skips that stack rather than throwing', async () => {
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/projects/demo/repo/compose.yaml',
    cliReturning(() => ok(JSON.stringify([{ Name: 'repo', Status: 'running', ConfigFiles: null }]))),
  )
  expect(stacks).toEqual([])
})

// --- docker version ----------------------------------------------------------

test('daemon down: non-zero exit with Client but no Server reports available:false and keeps the client version', async () => {
  const stdout = JSON.stringify({ Client: { Version: '26.1.4' } })
  const stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'
  const daemon = await getDaemonVersion(
    cliReturning(() => ({ ok: false, stdout, stderr, exitCode: 1 })),
  )
  expect(daemon).toEqual({
    cliInstalled: true,
    available: false,
    version: '26.1.4',
    error: stderr,
  })
})

test('daemon error text is capped at 2000 characters', async () => {
  const daemon = await getDaemonVersion(
    cliReturning(() => ({
      ok: false,
      stdout: JSON.stringify({ Client: { Version: '26.1.4' } }),
      stderr: 'x'.repeat(5000),
      exitCode: 1,
    })),
  )
  expect(daemon.error).toHaveLength(2000)
})

test('a missing docker binary (spawn ENOENT, exitCode -127) is cliInstalled:false with no error text', async () => {
  const daemon = await getDaemonVersion(
    cliReturning(() => ({
      ok: false,
      stdout: '',
      stderr: 'Executable not found in $PATH: "docker"',
      exitCode: -127,
    })),
  )
  expect(daemon).toEqual({ cliInstalled: false, available: false, version: null, error: null })
})

test('a zero-exit docker version whose JSON is unreadable still reports the CLI as installed', async () => {
  const daemon = await getDaemonVersion(cliReturning(() => ok('Client: Docker Engine - Community')))
  expect(daemon.cliInstalled).toBe(true)
  expect(daemon.available).toBe(false)
  expect(daemon.version).toBeNull()
})

test('compose version falls back to scavenging a version token, and to null when there is none', async () => {
  expect(await getComposeVersion(cliReturning(() => ok('Docker Compose version v2.24.0')))).toBe(
    'v2.24.0',
  )
  expect(await getComposeVersion(cliReturning(() => ok('no version here')))).toBeNull()
})

// --- host addresses ----------------------------------------------------------

test('host addresses always end with loopback, even with no tailscale on the box', async () => {
  // The live path, not assembleHosts (which docker-hosts.test.ts covers pure):
  // a box with no `tailscale` binary — this one — must degrade to a spawn
  // failure that is caught, not an unhandled rejection or a 500.
  const { getHostAddresses } = await import('../src/features/docker/hosts')
  const hosts = await getHostAddresses()
  expect(Array.isArray(hosts)).toBe(true)
  expect(hosts.at(-1)).toEqual({ kind: 'loopback', label: 'localhost', host: '127.0.0.1' })
  for (const host of hosts) {
    expect(['tailscale', 'lan', 'loopback']).toContain(host.kind)
    expect(host.host.length).toBeGreaterThan(0)
  }
})
