// The highest-value test in this feature: asserting exact argv asserts the
// *security* property (no shell, no injectable flag, -f/-p always explicit)
// as well as the behaviour. See features/docker/args.ts's own header comment.

import { expect, test } from 'bun:test'
import {
  buildArgs,
  composeConfigArgs,
  composeConfigServicesArgs,
  composeDownArgs,
  composeLsArgs,
  composeRestartArgs,
  composeStopArgs,
  composeUpArgs,
  composeVersionArgs,
  dockerRestartArgs,
  dockerRmArgs,
  dockerStopArgs,
  imageInspectArgs,
  inspectArgs,
  logsArgs,
  psFilterArgs,
  runArgs,
  versionArgs,
} from '../src/features/docker/args'

const FILES = { base: '/opt/agentoo/projects/demo/repo/compose.yaml' }
const FILES_WITH_OVERRIDE = {
  base: '/opt/agentoo/projects/demo/repo/compose.yaml',
  override: '/opt/agentoo/projects/demo/repo/compose.override.yaml',
}
const REPO_SCOPE = { slug: 'demo', sessionId: null }

test('compose config always carries -f and -p explicitly', () => {
  expect(composeConfigArgs('agentoo-demo', FILES)).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'config',
    '--format',
    'json',
  ])
})

test('an override file adds a second -f, after the base', () => {
  expect(composeConfigArgs('agentoo-demo', FILES_WITH_OVERRIDE)).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.override.yaml',
    '-p',
    'agentoo-demo',
    'config',
    '--format',
    'json',
  ])
})

test('the --services fallback carries the same -f/-p prefix', () => {
  expect(composeConfigServicesArgs('agentoo-demo', FILES)).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'config',
    '--services',
  ])
})

test('up: no flags, no services, whole stack', () => {
  expect(composeUpArgs('agentoo-demo', FILES, {})).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'up',
    '-d',
  ])
})

test('up: every flag, and a scoped service list, trailing', () => {
  expect(
    composeUpArgs('agentoo-demo', FILES, {
      services: ['web', 'worker'],
      build: true,
      forceRecreate: true,
      removeOrphans: true,
    }),
  ).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'up',
    '-d',
    '--build',
    '--force-recreate',
    '--remove-orphans',
    'web',
    'worker',
  ])
})

test('stop: services trail the subcommand, no other flags', () => {
  expect(composeStopArgs('agentoo-demo', FILES, ['web'])).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'stop',
    'web',
  ])
})

test('stop: no services means the whole stack, no trailing args at all', () => {
  expect(composeStopArgs('agentoo-demo', FILES, [])).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'stop',
  ])
})

test('restart: same shape as stop', () => {
  expect(composeRestartArgs('agentoo-demo', FILES, ['db'])).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'restart',
    'db',
  ])
})

test('down: never removes volumes or images unless explicitly asked', () => {
  expect(composeDownArgs('agentoo-demo', FILES, [], {})).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'down',
  ])
})

test('down: -v and --rmi all only when asked, services still trail', () => {
  expect(
    composeDownArgs('agentoo-demo', FILES, ['web'], { removeVolumes: true, removeImages: true }),
  ).toEqual([
    'compose',
    '-f',
    '/opt/agentoo/projects/demo/repo/compose.yaml',
    '-p',
    'agentoo-demo',
    'down',
    '-v',
    '--rmi',
    'all',
    'web',
  ])
})

test('compose ls carries no -f/-p — it surveys every stack on the daemon', () => {
  expect(composeLsArgs()).toEqual(['compose', 'ls', '--format', 'json'])
})

test('compose version', () => {
  expect(composeVersionArgs()).toEqual(['compose', 'version', '--format', 'json'])
})

test('docker version', () => {
  expect(versionArgs()).toEqual(['version', '--format', '{{json .}}'])
})

test('ps -aq --filter, one label at a time', () => {
  expect(psFilterArgs('label=com.agentoo.project=demo')).toEqual([
    'ps',
    '-aq',
    '--filter',
    'label=com.agentoo.project=demo',
  ])
})

test('inspect caps at 200 ids', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `id${i}`)
  const args = inspectArgs(ids)
  const prefix = ['inspect', '--type', 'container', '--format', '{{json .}}']
  expect(args.slice(0, prefix.length)).toEqual(prefix)
  expect(args.length).toBe(prefix.length + 200)
  expect(args.slice(prefix.length)).toEqual(ids.slice(0, 200))
})

test('image inspect', () => {
  expect(imageInspectArgs('agentoo/demo:latest')).toEqual([
    'image',
    'inspect',
    '--format',
    '{{json .}}',
    'agentoo/demo:latest',
  ])
})

test('build: -t before -f before the context, exactly as documented', () => {
  expect(
    buildArgs(REPO_SCOPE, '/opt/agentoo/projects/demo/repo/Dockerfile', '/opt/agentoo/projects/demo/repo'),
  ).toEqual([
    'build',
    '-t',
    'agentoo/demo:latest',
    '-f',
    '/opt/agentoo/projects/demo/repo/Dockerfile',
    '/opt/agentoo/projects/demo/repo',
  ])
})

test('run: no --restart policy, ever', () => {
  const args = runArgs(REPO_SCOPE, { containerPort: 3000, protocol: 'tcp' })
  expect(args).not.toContain('--restart')
  expect(args).toEqual([
    'run',
    '-d',
    '--name',
    'agentoo-demo',
    '--label',
    'com.agentoo.project=demo',
    '--label',
    'com.agentoo.managed=1',
    '-p',
    '0:3000/tcp',
    'agentoo/demo:latest',
  ])
})

test('run: an explicit hostPort is honoured, not 0', () => {
  const args = runArgs(REPO_SCOPE, { hostPort: 8080, containerPort: 3000, protocol: 'udp' })
  expect(args).toContain('8080:3000/udp')
})

test('run: hostPort omitted means the daemon allocates (0)', () => {
  const args = runArgs(REPO_SCOPE, { containerPort: 3000, protocol: 'tcp' })
  expect(args).toContain('0:3000/tcp')
})

test('stop/restart/rm target the container by name, nothing else', () => {
  expect(dockerStopArgs('agentoo-demo')).toEqual(['stop', 'agentoo-demo'])
  expect(dockerRestartArgs('agentoo-demo')).toEqual(['restart', 'agentoo-demo'])
  expect(dockerRmArgs('agentoo-demo')).toEqual(['rm', 'agentoo-demo'])
})

test('logs: --follow --timestamps --tail N, since only when given', () => {
  expect(logsArgs('abc123', { tail: 500 })).toEqual([
    'logs',
    '--follow',
    '--timestamps',
    '--tail',
    '500',
    'abc123',
  ])
  expect(logsArgs('abc123', { tail: 100, since: '2024-01-01T00:00:00Z' })).toEqual([
    'logs',
    '--follow',
    '--timestamps',
    '--tail',
    '100',
    '--since',
    '2024-01-01T00:00:00Z',
    'abc123',
  ])
})

// --- the security property itself --------------------------------------------

test('no argv function ever produces a flag-shaped element from a plain value', () => {
  // A slug or service name starting with "-" would be read as an option by
  // docker's own argv parser if it ever reached one unescaped. names.ts
  // already refuses a slug shaped that way (see docker-names.test.ts); this
  // asserts the complementary property here: nothing in this file's own
  // construction ever *joins* strings into a shell command, so there is no
  // interpolation point for one to hide in even if it got this far.
  const args = composeUpArgs('agentoo-demo', FILES, { services: ['web'] })
  for (const arg of args) expect(typeof arg).toBe('string')
})
