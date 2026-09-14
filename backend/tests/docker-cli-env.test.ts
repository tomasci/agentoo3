// CLAIM 6: the compose child must get { ...process.env, ...options.env }, not
// a bare replacement. Exercised through the REAL realDockerCli, against a
// `docker` shim placed on PATH -- if the merge were a bare replacement the
// shim would not even be found (ENOENT / MISSING_BINARY_EXIT_CODE), so this
// fails for exactly one reason.

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import './setup-env'
import { MISSING_BINARY_EXIT_CODE, realDockerCli } from '../src/features/docker/cli'

const shimDir = await mkdtemp(join(tmpdir(), 'agentoo-docker-shim-'))
const shim = join(shimDir, 'docker')
await writeFile(shim, '#!/bin/sh\nenv\n')
await chmod(shim, 0o755)
const originalPath = process.env.PATH
process.env.PATH = `${shimDir}:${originalPath}`
process.env.AGENTOO_CLI_ENV_TEST_INHERITED = 'inherited-value'

function parse(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

test('run(): PATH and other inherited vars survive, and options.env is merged on top', async () => {
  const result = await realDockerCli.run(['anything'], {
    timeoutMs: 10_000,
    env: { AGENTOO_PORT_0: '20010', AGENTOO_SCOPE: 'worktree' },
  })
  expect(result.exitCode).not.toBe(MISSING_BINARY_EXIT_CODE)
  expect(result.ok).toBe(true)
  const childEnv = parse(result.stdout)
  expect(childEnv.PATH).toBe(process.env.PATH as string)
  expect(childEnv.AGENTOO_CLI_ENV_TEST_INHERITED).toBe('inherited-value')
  expect(childEnv.AGENTOO_PORT_0).toBe('20010')
  expect(childEnv.AGENTOO_SCOPE).toBe('worktree')
  expect(childEnv.HOME).toBe(process.env.HOME as string)
})

test('run(): no options.env still inherits the full environment', async () => {
  const result = await realDockerCli.run(['anything'], { timeoutMs: 10_000 })
  const childEnv = parse(result.stdout)
  expect(childEnv.PATH).toBe(process.env.PATH as string)
  expect(childEnv.AGENTOO_CLI_ENV_TEST_INHERITED).toBe('inherited-value')
})

test('stream(): PATH survives and options.env is merged on top', async () => {
  const stream = realDockerCli.stream(['anything'], {
    env: { AGENTOO_PORT_0: '20010' },
  })
  const lines: string[] = []
  for await (const line of stream.lines) lines.push(line.line)
  await stream.exited
  const childEnv = parse(lines.join('\n'))
  expect(childEnv.PATH).toBe(process.env.PATH as string)
  expect(childEnv.AGENTOO_PORT_0).toBe('20010')
  expect(childEnv.HOME).toBe(process.env.HOME as string)
})

test('DOCKER_HOST, when set, reaches the child', async () => {
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
  const result = await realDockerCli.run(['anything'], { timeoutMs: 10_000 })
  expect(parse(result.stdout).DOCKER_HOST).toBe('unix:///var/run/docker.sock')
  delete process.env.DOCKER_HOST
})
