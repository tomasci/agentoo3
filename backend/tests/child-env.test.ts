// lib/child-env.ts, and the two spawn wrappers that run project-controlled
// code with it: `realDockerCli` (a `docker compose` interpolates the
// project's compose file from its env) and `git()` (a repository's own hooks
// run with git's env). Both are exercised for real — a `docker` shim on PATH
// that prints its env, and a real post-checkout hook in a real repository —
// so each assertion is about what the child process actually received.
//
// The session env itself (runner-options.ts) is covered by
// runner-options-env.test.ts, which needs a child process of its own.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './setup-env'
import {
  CANARY_CREDENTIALS,
  CLAUDE_CREDENTIALS,
  leakedCanaries,
  REQUIRED_SCRUBBED,
  withCanaryEnv,
} from './app-credentials'

const { APP_CREDENTIAL_VARS, withoutAppCredentials } = await import('../src/lib/child-env')
const { realDockerCli } = await import('../src/features/docker/cli')
const { addWorktree, git } = await import('../src/lib/git')

function parseEnv(dump: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of dump.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

/** Every required name absent, no canary value under any name, both Claude
 * credentials intact — the same three claims for every child below. */
function expectScrubbed(env: Record<string, string>) {
  for (const key of REQUIRED_SCRUBBED) expect(Object.keys(env)).not.toContain(key)
  expect(leakedCanaries(env)).toEqual([])
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_CREDENTIALS.CLAUDE_CODE_OAUTH_TOKEN as string)
  expect(env.ANTHROPIC_API_KEY).toBe(CLAUDE_CREDENTIALS.ANTHROPIC_API_KEY as string)
}

let dir: string
const originalPath = process.env.PATH

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-child-env-'))
  // A `docker` that prints the environment it was started with.
  const shimDir = join(dir, 'bin')
  await mkdir(shimDir)
  await writeFile(join(shimDir, 'docker'), '#!/bin/sh\nenv\n')
  await chmod(join(shimDir, 'docker'), 0o755)
  process.env.PATH = `${shimDir}:${originalPath}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await rm(dir, { recursive: true, force: true })
})

// --- the helper itself ----------------------------------------------------

test('withoutAppCredentials removes every required name and keeps everything else', () => {
  const source = {
    ...CANARY_CREDENTIALS,
    ...CLAUDE_CREDENTIALS,
    PATH: '/usr/bin',
    HOME: '/home/someone',
    AGENTOO_SCOPE: 'worktree',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
  }
  const out = withoutAppCredentials(source)
  expectScrubbed(out)
  expect(out).toEqual({
    ...CLAUDE_CREDENTIALS,
    PATH: '/usr/bin',
    HOME: '/home/someone',
    AGENTOO_SCOPE: 'worktree',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
  })
})

test('the list covers every required name, and never a Claude credential', () => {
  for (const key of REQUIRED_SCRUBBED) expect(APP_CREDENTIAL_VARS).toContain(key)
  for (const key of Object.keys(CLAUDE_CREDENTIALS)) {
    expect(APP_CREDENTIAL_VARS as readonly string[]).not.toContain(key)
  }
})

test('the source is left alone, and keys are absent rather than undefined', () => {
  const source: Record<string, string | undefined> = {
    DATABASE_URL: CANARY_CREDENTIALS.DATABASE_URL,
    PGPASSWORD: CANARY_CREDENTIALS.PGPASSWORD,
    UNSET: undefined,
    KEPT: 'yes',
  }
  const out = withoutAppCredentials(source)
  expect(source.DATABASE_URL).toBe(CANARY_CREDENTIALS.DATABASE_URL as string)
  expect(source.PGPASSWORD).toBe(CANARY_CREDENTIALS.PGPASSWORD as string)
  expect('DATABASE_URL' in out).toBe(false)
  expect('PGPASSWORD' in out).toBe(false)
  expect('UNSET' in out).toBe(false)
  expect(out).toEqual({ KEPT: 'yes' })
})

// --- docker: `docker compose` interpolates the project's file from this env

test('docker run(): no credential reaches docker, the compose env and the rest still do', async () => {
  await withCanaryEnv(async () => {
    const result = await realDockerCli.run(['compose', 'up'], {
      timeoutMs: 10_000,
      env: { AGENTOO_PORT_0: '20010', AGENTOO_SCOPE: 'worktree' },
    })
    expect(result.ok).toBe(true)
    const env = parseEnv(result.stdout)
    expectScrubbed(env)
    expect(env.PATH).toBe(process.env.PATH as string)
    expect(env.AGENTOO_PORT_0).toBe('20010')
    expect(env.AGENTOO_SCOPE).toBe('worktree')
  })
})

test('docker stream(): no credential reaches docker either', async () => {
  await withCanaryEnv(async () => {
    const stream = realDockerCli.stream(['compose', 'up'], { env: { AGENTOO_PORT_0: '20010' } })
    const lines: string[] = []
    for await (const line of stream.lines) lines.push(line.line)
    expect(await stream.exited).toBe(0)
    const env = parseEnv(lines.join('\n'))
    expectScrubbed(env)
    expect(env.AGENTOO_PORT_0).toBe('20010')
  })
})

// --- git: a project's own hooks run with git's env -------------------------

test("a project's post-checkout hook, fired by addWorktree, sees no credential", async () => {
  const repo = join(dir, 'repo')
  const dump = join(dir, 'hook-env.txt')
  expect((await git(['init', '-q', '-b', 'main', repo], dir)).ok).toBe(true)
  await writeFile(join(repo, 'keep.txt'), 'x\n')
  await git(['add', '-A'], repo)
  const commit = await git(
    ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'seed'],
    repo,
  )
  expect(commit.ok).toBe(true)
  // Project-controlled code, exactly as a repository with husky or lefthook
  // installed has: git runs it with git's own environment.
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\nenv > '${dump}'\n`)
  await chmod(hook, 0o755)

  await withCanaryEnv(async () => {
    const added = await addWorktree(repo, join(dir, 'wt'), 'agentoo/s-child-env')
    expect(added.ok).toBe(true)
  })

  const env = parseEnv(await readFile(dump, 'utf8'))
  expect(env.PATH).toBeDefined()
  expectScrubbed(env)
})
