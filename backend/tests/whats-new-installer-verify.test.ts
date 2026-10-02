// scripts/68-setup-backend.sh's "record this install" block, run for real
// under the installer's own shell settings.
//
// The block is extracted verbatim from the shipped script (located by its own
// first and last lines) and run after sourcing the real scripts/lib/common.sh
// — so `set -Eeuo pipefail` and the `trap _on_err ERR` that turns any
// unguarded failure into an abort are the real ones, not a re-statement.
// Only `run_as_app` is stubbed (it needs a service account and sudo/runuser);
// it still runs the real `bun run mark-install` against a throwaway
// BACKEND_DIR whose package.json decides whether that script succeeds.
//
// A control case runs the same harness with the command unguarded, to show
// the harness does abort on a failure — otherwise "the install continued"
// would prove nothing.
//
// The dry-run case runs the whole script with DRY_RUN=1 and a `bun` tripwire
// on PATH, and asserts bun is never invoked at all.

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'

setDefaultTimeout(30_000)

const REPO = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO, 'scripts', '68-setup-backend.sh')
const COMMON = join(REPO, 'scripts', 'lib', 'common.sh')
const BUN = process.execPath
const BASH = Bun.which('bash') ?? '/bin/bash'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

async function scriptLines(): Promise<string[]> {
  return (await Bun.file(SCRIPT).text()).split('\n')
}

/** The mark-install block: from its own comment header to the `fi` that closes it. */
async function markInstallBlock(): Promise<string> {
  const lines = await scriptLines()
  const start = lines.findIndex((l) => l.startsWith('# Records "an install/update just ran"'))
  const ifLine = lines.findIndex((l, i) => i > start && l.startsWith('if run_as_app') && l.includes('mark-install'))
  const closing = lines.indexOf('fi', ifLine)
  expect(start).toBeGreaterThan(-1)
  expect(ifLine).toBeGreaterThan(start)
  expect(closing).toBeGreaterThan(ifLine)
  const block = lines.slice(start, closing + 1).join('\n')
  expect(block).toContain('bun run mark-install')
  expect(block).toContain('log_warn')
  return block
}

/** A BACKEND_DIR whose `mark-install` script runs `body`. */
async function fakeBackend(version: string, body: string): Promise<string> {
  const dir = await tempDir('agentoo-wn-backend-')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake', version, scripts: { 'mark-install': body } }),
  )
  return dir
}

/** A PATH holding only what the harness needs; `jq` included only on request. */
async function pathDir(withJq: boolean): Promise<string> {
  const bin = await tempDir('agentoo-wn-bin-')
  const tools = ['bash', 'sh', 'date', 'mkdir', 'dirname', 'id', 'cat', 'env', 'true', 'false']
  if (withJq) tools.push('jq')
  for (const t of tools) {
    const found = Bun.which(t)
    if (found) await symlink(found, join(bin, t))
  }
  await symlink(BUN, join(bin, 'bun'))
  return bin
}

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

async function runBlock(opts: {
  backendDir: string
  block: string
  withJq?: boolean
  runAsApp?: string
}): Promise<Result> {
  const state = await tempDir('agentoo-wn-state-')
  const harness = [
    '#!/usr/bin/env bash',
    `. '${COMMON}'`,
    `BACKEND_DIR='${opts.backendDir}'`,
    "db_url='postgres://unused@127.0.0.1:1/unused'",
    // The real one is `as_user "$APP_USER" env HOME=... PATH=... "$@"`.
    opts.runAsApp ?? 'run_as_app() { "$@"; }',
    opts.block,
    'echo REACHED_SERVICES',
    '',
  ].join('\n')
  const path = join(state, 'harness.sh')
  await writeFile(path, harness)
  await chmod(path, 0o755)
  const proc = Bun.spawn([BASH, path], {
    env: {
      PATH: await pathDir(opts.withJq ?? true),
      HOME: process.env.HOME ?? '/tmp',
      REPO_ROOT: state,
      LOG_DIR: join(state, 'log'),
      STATE_DIR: join(state, 'state'),
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

test('a failing mark-install only warns; the install carries on to services', async () => {
  const backend = await fakeBackend('9.9.9', 'echo boom >&2; exit 3')
  const r = await runBlock({ backendDir: backend, block: await markInstallBlock() })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('REACHED_SERVICES')
  // The real `bun run mark-install` ran and failed — not a missing bun.
  expect(r.stderr).toContain('boom')
  expect(r.stderr).toContain("WARN  Could not record this install for the What's new screen (not fatal).")
  expect(r.stderr).not.toContain('failed with exit')
  expect(r.stderr).not.toContain('Recorded install')
})

test('run_as_app itself failing (bun not found, exit 127) only warns too', async () => {
  const backend = await fakeBackend('9.9.9', 'exit 0')
  const r = await runBlock({
    backendDir: backend,
    block: await markInstallBlock(),
    runAsApp: 'run_as_app() { no-such-command-agentoo "$@"; }',
  })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('REACHED_SERVICES')
  expect(r.stderr).toContain('Could not record this install')
  expect(r.stderr).not.toContain('failed with exit')
})

test('a succeeding mark-install logs the package.json version it recorded', async () => {
  const backend = await fakeBackend('9.9.9', 'echo recorded')
  const r = await runBlock({ backendDir: backend, block: await markInstallBlock() })
  expect(r.stdout).toContain('recorded')
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('REACHED_SERVICES')
  expect(r.stderr).toContain("OK    Recorded install 9.9.9 for the What's new screen")
  expect(r.stderr).not.toContain('Could not record')
})

test('with no jq on PATH a successful mark-install still logs OK (version "?") and carries on', async () => {
  const backend = await fakeBackend('9.9.9', 'echo recorded')
  const r = await runBlock({ backendDir: backend, block: await markInstallBlock(), withJq: false })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('REACHED_SERVICES')
  expect(r.stderr).toContain("Recorded install ? for the What's new screen")
  expect(r.stderr).not.toContain('failed with exit')
})

test('control: the same harness aborts via the ERR trap when the call is unguarded', async () => {
  const backend = await fakeBackend('9.9.9', 'exit 3')
  const unguarded = `run_as_app bash -c "cd '$BACKEND_DIR' && DATABASE_URL='$db_url' bun run mark-install"`
  const r = await runBlock({ backendDir: backend, block: unguarded })
  expect(r.code).not.toBe(0)
  expect(r.stdout).not.toContain('REACHED_SERVICES')
  expect(r.stderr).toContain('failed with exit')
})

test('the block sits after migrations and before the services section', async () => {
  const lines = await scriptLines()
  const migrate = lines.findIndex((l) => l.includes('bun run db:migrate'))
  const migrated = lines.findIndex((l) => l.includes('log_ok "Migrations applied"'))
  const mark = lines.findIndex((l) => l.includes('bun run mark-install'))
  const services = lines.findIndex((l) => l.startsWith('# --- services'))
  expect(migrate).toBeGreaterThan(-1)
  expect(migrated).toBeGreaterThan(migrate)
  expect(mark).toBeGreaterThan(migrated)
  expect(services).toBeGreaterThan(mark)
  // Same env shape as the migrate line: only DATABASE_URL added.
  expect(lines[mark]).toContain(`DATABASE_URL='$db_url' bun run mark-install`)
  expect(lines[mark]).not.toMatch(/REDIS_URL|PROJECTS_DIR|ATTACHMENTS_DIR/)
})

const isRoot = process.getuid?.() === 0

;(isRoot ? test.skip : test)('DRY_RUN=1 never invokes bun, so never runs mark-install', async () => {
  const box = await tempDir('agentoo-wn-dry-')
  const bin = join(box, 'bin')
  await mkdir(bin)
  const trip = join(box, 'TRIPPED')
  for (const t of ['bun', 'sudo', 'runuser', 'psql', 'systemctl']) {
    await writeFile(join(bin, t), `#!${BASH}\nprintf '%s %s\\n' "${t}" "$*" >>"${trip}"\nexit 97\n`)
    await chmod(join(bin, t), 0o755)
  }
  const proc = Bun.spawn([BASH, SCRIPT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '/tmp',
      DRY_RUN: '1',
      LOG_DIR: join(box, 'log'),
      STATE_DIR: join(box, 'state'),
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect(code).toBe(0)
  expect(stderr).toContain('[dry-run] would install')
  const tripped = await readFile(trip, 'utf8').catch(() => '')
  // `sudo -n true` is can_sudo()'s probe; nothing else may run.
  const calls = tripped.split('\n').filter((l) => l && l !== 'sudo -n true')
  expect(calls).toEqual([])
  expect(stderr).not.toContain('Recorded install')
  expect(stderr).not.toContain('Could not record')
})
