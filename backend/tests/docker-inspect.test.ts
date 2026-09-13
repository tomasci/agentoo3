// Parses the fixtures in tests/fixtures/docker/ — captured/representative
// shapes only, never verified against a real daemon (there is none on this
// host). Every parser under test must degrade, not throw, on anything it
// does not recognise.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  getDaemonVersion,
  inspectImage,
  listContainerIds,
  parseContainerInspectNdjson,
  toDockerContainer,
} from '../src/features/docker/inspect'
import type { DockerCli, DockerResult, DockerStream } from '../src/features/docker/cli'

const FIXTURES = join(import.meta.dir, 'fixtures', 'docker')

function fakeCli(run: (args: string[]) => Promise<DockerResult>): DockerCli {
  return {
    run,
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
}

const ok = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string, exitCode = 1): DockerResult => ({ ok: false, stdout: '', stderr, exitCode })

// --- NDJSON parsing -----------------------------------------------------------

test('parses one JSON object per line (NDJSON), not a JSON array', async () => {
  const text = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
  const containers = parseContainerInspectNdjson(text)
  expect(containers).toHaveLength(3)
})

test('.Name has its leading slash stripped', async () => {
  const text = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
  const [first] = parseContainerInspectNdjson(text)
  expect(first?.Name).toBe('/demo-web-1')
  const dto = toDockerContainer(first!)
  expect(dto.name).toBe('demo-web-1')
})

test('a running, healthy, published-port container maps correctly', async () => {
  const text = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
  const [raw] = parseContainerInspectNdjson(text)
  const dto = toDockerContainer(raw!)
  expect(dto.state).toBe('running')
  expect(dto.health).toBe('healthy')
  expect(dto.service).toBe('web')
  expect(dto.ports).toEqual([{ containerPort: 3000, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 32768 }])
  // 9229/tcp is null in the fixture: exposed but never published.
  expect(dto.ports.some((p) => p.containerPort === 9229)).toBe(false)
  expect(dto.startedAt).toBe('2024-01-02T10:00:00.000000000Z')
  expect(dto.finishedAt).toBeNull() // the docker zero-time sentinel
})

test('an exited container with null NetworkSettings.Ports maps to no ports and "none" health', async () => {
  const text = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
  const [, second] = parseContainerInspectNdjson(text)
  const dto = toDockerContainer(second!)
  expect(dto.state).toBe('exited')
  expect(dto.health).toBe('none')
  expect(dto.ports).toEqual([])
  expect(dto.exitCode).toBe(1)
  expect(dto.finishedAt).toBe('2024-01-02T09:05:00.000000000Z')
})

test('a plain-Dockerfile-managed container has service: null', async () => {
  const text = await readFile(join(FIXTURES, 'inspect.ndjson'), 'utf8')
  const [, , third] = parseContainerInspectNdjson(text)
  const dto = toDockerContainer(third!)
  expect(dto.service).toBeNull()
  expect(dto.ports).toEqual([{ containerPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 40000 }])
})

test('a line that is not JSON at all is skipped, not fatal', () => {
  const containers = parseContainerInspectNdjson('not json\n{"Id":"abc"}\n')
  expect(containers).toEqual([{ Id: 'abc' }])
})

test('a JSON line missing the required Id field is skipped', () => {
  const containers = parseContainerInspectNdjson('{"Name":"/x"}\n{"Id":"abc"}\n')
  expect(containers).toEqual([{ Id: 'abc' }])
})

test('blank lines between entries are ignored', () => {
  const containers = parseContainerInspectNdjson('{"Id":"abc"}\n\n\n{"Id":"def"}\n')
  expect(containers).toHaveLength(2)
})

// --- docker ps -aq --filter ----------------------------------------------------

test('listContainerIds splits on newlines and drops blanks', async () => {
  const cli = fakeCli(async () => ok('abc123\ndef456\n\n'))
  expect(await listContainerIds('label=x', cli)).toEqual(['abc123', 'def456'])
})

test('listContainerIds degrades to [] when the command fails', async () => {
  const cli = fakeCli(async () => fail('no such thing'))
  expect(await listContainerIds('label=x', cli)).toEqual([])
})

// --- docker image inspect -------------------------------------------------------

test('image inspect reports exposed ports and a build time', async () => {
  const cli = fakeCli(async () =>
    ok(
      JSON.stringify({
        Created: '2024-03-01T00:00:00Z',
        Config: { ExposedPorts: { '3000/tcp': {}, '4000/udp': {} } },
      }),
    ),
  )
  const image = await inspectImage('agentoo/demo:latest', cli)
  expect(image.exists).toBe(true)
  expect(image.builtAt).toBe('2024-03-01T00:00:00Z')
  expect(image.exposedPorts).toEqual([
    { containerPort: 3000, protocol: 'tcp' },
    { containerPort: 4000, protocol: 'udp' },
  ])
})

test('image inspect on a missing image degrades to exists: false', async () => {
  const cli = fakeCli(async () => fail('No such image: agentoo/demo:latest'))
  const image = await inspectImage('agentoo/demo:latest', cli)
  expect(image).toEqual({ exists: false, builtAt: null, exposedPorts: [] })
})

test('image inspect on an unrecognised shape degrades rather than throwing', async () => {
  const cli = fakeCli(async () => ok('null'))
  const image = await inspectImage('agentoo/demo:latest', cli)
  expect(image.exists).toBe(false)
})

// --- docker version -------------------------------------------------------------

test('docker version, daemon up: available with both versions', async () => {
  const text = await readFile(join(FIXTURES, 'version.json'), 'utf8')
  const cli = fakeCli(async () => ok(text))
  const version = await getDaemonVersion(cli)
  expect(version).toEqual({ cliInstalled: true, available: true, version: '26.1.4', error: null })
})

test('docker version, daemon down: non-zero exit, Client present, Server absent', async () => {
  // The real shape: docker version still prints the Client block and exits
  // non-zero when it cannot reach the daemon — Server is simply absent.
  const cli = fakeCli(async () => ({
    ok: false,
    stdout: JSON.stringify({ Client: { Version: '26.1.4' } }),
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    exitCode: 1,
  }))
  const version = await getDaemonVersion(cli)
  expect(version.cliInstalled).toBe(true)
  expect(version.available).toBe(false)
  expect(version.version).toBe('26.1.4')
  expect(version.error).toContain('Cannot connect to the Docker daemon')
})

test('a missing docker binary (spawn ENOENT) reports cliInstalled: false', async () => {
  const cli = fakeCli(async () => ({
    ok: false,
    stdout: '',
    stderr: 'ENOENT',
    exitCode: -127,
  }))
  const version = await getDaemonVersion(cli)
  expect(version).toEqual({ cliInstalled: false, available: false, version: null, error: null })
})
