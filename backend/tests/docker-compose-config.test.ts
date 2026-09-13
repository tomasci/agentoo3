import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  foreignStacksFor,
  getComposeConfig,
  getComposeVersion,
} from '../src/features/docker/compose-config'
import type { DockerCli, DockerResult, DockerStream } from '../src/features/docker/cli'

const FIXTURES = join(import.meta.dir, 'fixtures', 'docker')
const FILES = { base: '/opt/agentoo/projects/demo/repo/compose.yaml' }

const UNSET: DockerResult = { ok: false, stdout: '', stderr: 'unset', exitCode: 1 }

/** Dispatches on which subcommand argv contains — good enough for a fake
 * that only ever sees one of config/--services/ls/version per test. */
function fakeCli(handlers: Partial<Record<'config' | 'services' | 'ls' | 'version', DockerResult>>): DockerCli {
  return {
    async run(args) {
      if (args.includes('ls')) return handlers.ls ?? UNSET
      if (args.includes('--services')) return handlers.services ?? UNSET
      if (args.includes('config')) return handlers.config ?? UNSET
      if (args.includes('version')) return handlers.version ?? UNSET
      throw new Error(`unexpected argv in test fake: ${args.join(' ')}`)
    },
    stream(): DockerStream {
      throw new Error('not used in this test')
    },
  }
}

const ok = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): DockerResult => ({ ok: false, stdout: '', stderr, exitCode: 1 })

// --- docker compose config --format json ---------------------------------------

test('parses services, ports (short and long), depends_on as a map or an array, and build', async () => {
  const configJson = await readFile(join(FIXTURES, 'compose-config.json'), 'utf8')
  const cli = fakeCli({ config: ok(configJson) })

  const result = await getComposeConfig('agentoo-demo', FILES, '/opt/agentoo/projects/demo/repo', cli)
  expect(result.ok).toBe(true)
  expect(result.configError).toBeNull()

  const web = result.services.find((s) => s.name === 'web')
  expect(web).toBeDefined()
  expect(web?.build).toBe(true)
  expect(web?.dependsOn).toEqual(['worker']) // depends_on as a map
  expect(web?.declaredPorts).toEqual([
    { containerPort: 3000, publishedPort: 3000, publishedRange: null, protocol: 'tcp', hostIp: null },
    { containerPort: 9229, publishedPort: null, publishedRange: null, protocol: 'tcp', hostIp: null },
  ])

  const worker = result.services.find((s) => s.name === 'worker')
  expect(worker?.build).toBe(false)
  expect(worker?.profiles).toEqual(['background'])
  expect(worker?.dependsOn).toEqual(['db']) // depends_on as an array

  const db = result.services.find((s) => s.name === 'db')
  expect(db?.declaredPorts).toEqual([
    { containerPort: 5432, publishedPort: null, publishedRange: '5432-5439', protocol: 'tcp', hostIp: '127.0.0.1' },
  ])
})

test('a broken compose file degrades to a trimmed configError and (if possible) names-only services', async () => {
  const cli = fakeCli({
    config: fail('yaml: line 4: mapping values are not allowed in this context'),
    services: ok('web\nworker\n'),
  })
  const result = await getComposeConfig('agentoo-demo', FILES, '/opt/agentoo/projects/demo/repo', cli)
  expect(result.ok).toBe(false)
  expect(result.configError).toContain('mapping values are not allowed')
  expect(result.services.map((s) => s.name)).toEqual(['web', 'worker'])
  // Degraded services carry no ports — those come from running containers.
  expect(result.services.every((s) => s.declaredPorts.length === 0)).toBe(true)
})

test('configError is truncated to 2000 characters', async () => {
  const cli = fakeCli({ config: fail('x'.repeat(5000)), services: fail('also broken') })
  const result = await getComposeConfig('agentoo-demo', FILES, '/opt/agentoo/projects/demo/repo', cli)
  expect(result.configError?.length).toBe(2000)
})

test('an unparseable JSON response also degrades rather than throwing', async () => {
  const cli = fakeCli({ config: ok('not json'), services: ok('web\n') })
  const result = await getComposeConfig('agentoo-demo', FILES, '/opt/agentoo/projects/demo/repo', cli)
  expect(result.ok).toBe(false)
  expect(result.services.map((s) => s.name)).toEqual(['web'])
})

// --- docker compose version -----------------------------------------------------

test('parses {"version": "..."} from --format json', async () => {
  const cli = fakeCli({ version: ok(JSON.stringify({ version: 'v2.24.0' })) })
  expect(await getComposeVersion(cli)).toBe('v2.24.0')
})

test('falls back to scavenging a version token from a plaintext response', async () => {
  const cli = fakeCli({ version: ok('Docker Compose version v2.24.0\n') })
  expect(await getComposeVersion(cli)).toBe('v2.24.0')
})

test('a failed compose version call is null, not an error', async () => {
  const cli = fakeCli({ version: fail('no such command') })
  expect(await getComposeVersion(cli)).toBeNull()
})

// --- docker compose ls --format json (foreign stacks) ---------------------------

test('a stack sharing our compose file under a different name is reported as foreign', async () => {
  const lsJson = await readFile(join(FIXTURES, 'compose-ls.json'), 'utf8')
  const cli = fakeCli({ ls: ok(lsJson) })

  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    cli,
  )
  expect(stacks).toEqual([
    {
      name: 'repo',
      status: 'running(1)',
      configFiles: ['/opt/agentoo/projects/demo/repo/compose.yaml'],
    },
  ])
})

test('ConfigFiles is split on commas, not treated as a single path', async () => {
  const lsJson = await readFile(join(FIXTURES, 'compose-ls.json'), 'utf8')
  const cli = fakeCli({ ls: ok(lsJson) })
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/opt/agentoo/projects/other/repo/compose.override.yaml',
    cli,
  )
  expect(stacks.map((s) => s.name)).toEqual(['some-other-stack'])
})

test('a failed compose ls degrades to [], never an error', async () => {
  const cli = fakeCli({ ls: fail('daemon unreachable') })
  const stacks = await foreignStacksFor('agentoo-demo', '/x/compose.yaml', cli)
  expect(stacks).toEqual([])
})

test('a non-array response from compose ls degrades to []', async () => {
  const cli = fakeCli({ ls: ok('{"not":"an array"}') })
  const stacks = await foreignStacksFor('agentoo-demo', '/x/compose.yaml', cli)
  expect(stacks).toEqual([])
})

test('our own stack is never reported as foreign', async () => {
  const lsJson = await readFile(join(FIXTURES, 'compose-ls.json'), 'utf8')
  const cli = fakeCli({ ls: ok(lsJson) })
  const stacks = await foreignStacksFor(
    'agentoo-demo',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    cli,
  )
  expect(stacks.find((s) => s.name === 'agentoo-demo')).toBeUndefined()
})
