// bootstrap.sh's handling of how it was invoked — the recommended
// `sudo bash -c "$(curl ...)"` form, the `curl | sudo bash` form, and `sh` —
// plus the README text that tells operators which to use.
//
// bootstrap.sh is NEVER run far enough to do anything here. Every run passes
// `--help`, which the argument loop handles by returning before need_root,
// git, apt or any write; and every run's PATH is a temp dir holding only
// `cat` (the usage heredoc) plus tripwires for everything bootstrap could
// reach past that point (git, sudo, apt-get, curl, install, chown, ...). A
// tripwire records its argv and exits 97, and every test asserts none fired —
// so a regression that stopped `--help` from returning early fails loudly
// here instead of touching this machine.

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

setDefaultTimeout(30_000)

const REPO = join(import.meta.dir, '..', '..')
const BOOTSTRAP = join(REPO, 'bootstrap.sh')
const README = join(REPO, 'README.md')
const PTY_RUN = join(import.meta.dir, 'fixtures', 'install-https', 'pty-run.py')
const PYTHON = Bun.which('python3')
const BASH = Bun.which('bash') ?? '/usr/bin/bash'
const SH = Bun.which('sh') ?? '/bin/sh'

const RAW = 'https://raw.githubusercontent.com/tomasci/agentoo3/main/bootstrap.sh'
const RECOMMENDED = `sudo bash -c "$(curl -fsSL ${RAW})"`
const PLACEHOLDER = 'sudo bash -c "$(curl -fsSL <url of bootstrap.sh>)"'
const NOTICE = 'No keyboard input available'
const USAGE = 'clone and install on a bare Ubuntu server'

const TRIPWIRES = [
  'git', 'sudo', 'apt-get', 'curl', 'install', 'chown', 'chmod', 'runuser', 'id', 'stat',
  'dirname', 'ls', 'base64', 'sed', 'awk', 'grep', 'mkdir', 'rm',
]

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

interface Box {
  root: string
  bin: string
  trip: string
}

async function makeBox(): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), 'agentoo-bootstrap-test-'))
  dirs.push(root)
  const box = { root, bin: join(root, 'bin'), trip: join(root, 'TRIPPED') }
  await mkdir(box.bin)
  for (const t of TRIPWIRES) {
    const p = join(box.bin, t)
    await writeFile(p, `#!${BASH}\nprintf '%s %s\\n' "${t}" "$*" >>"${box.trip}"\nexit 97\n`)
    await chmod(p, 0o755)
  }
  const cat = Bun.which('cat')
  if (!cat) throw new Error('test prerequisite missing on this host: cat')
  await symlink(cat, join(box.bin, 'cat'))
  return box
}

interface Out {
  code: number | null
  stdout: string
  stderr: string
  tripped: string
}

async function exec(
  box: Box,
  argv: string[],
  env: Record<string, string> = {},
  stdin: 'ignore' | string = 'ignore',
): Promise<Out> {
  const proc = Bun.spawn(argv, {
    cwd: box.root,
    env: { PATH: box.bin, HOME: box.root, LANG: 'C.UTF-8', TERM: 'dumb', ...env },
    stdin: stdin === 'ignore' ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (stdin !== 'ignore' && proc.stdin && typeof proc.stdin !== 'number') {
    proc.stdin.write(stdin)
    proc.stdin.end()
  }
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  let tripped = ''
  try {
    tripped = await readFile(box.trip, 'utf8')
  } catch {}
  return { code, stdout, stderr, tripped }
}

/** `bash -c "$(cat bootstrap.sh)" bootstrap <args...>` — the recommended form, minus curl. */
async function viaDashC(box: Box, args: string[], env: Record<string, string> = {}): Promise<Out> {
  const text = await readFile(BOOTSTRAP, 'utf8')
  return exec(box, [BASH, '-c', text, 'bootstrap', ...args], env)
}

function expectUsageOnly(r: Out): void {
  expect(r.tripped).toBe('')
  expect(r.code).toBe(0)
  expect(r.stderr).toContain(USAGE)
  expect(r.stderr).toContain('--repo URL')
  // --help returns before the banner that precedes any real work.
  expect(r.stderr).not.toContain('  bootstrap  ')
}

function noticeLines(r: Out): string[] {
  return r.stderr.split('\n').filter((l) => l.startsWith('INFO'))
}

// ================================================================= syntax ===

describe('bootstrap.sh parses and passes arguments through `bash -c "$(...)" name args...`', () => {
  test('bash -n bootstrap.sh', async () => {
    const box = await makeBox()
    const r = await exec(box, [BASH, '-n', BOOTSTRAP])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
  })

  test('bash -c "$(cat bootstrap.sh)" bootstrap --help -> usage, exit 0, nothing else runs', async () => {
    const box = await makeBox()
    expectUsageOnly(await viaDashC(box, ['--help']))
  })

  test('the literal shell form (real command substitution) behaves the same', async () => {
    const box = await makeBox()
    await symlink(BASH, join(box.bin, 'bash'))
    const r = await exec(box, [BASH, '-c', 'bash -c "$(cat "$1")" bootstrap --help', '_', BOOTSTRAP])
    expectUsageOnly(r)
  })

  test('args after the name all arrive: options before --help are parsed, then --help returns', async () => {
    const box = await makeBox()
    expectUsageOnly(await viaDashC(box, ['--branch', 'dev', '--dir', join(box.root, 'x'), '--skip', 'upgrade', '--help']))
  })

  test('no SUDO_USER, stdin not a tty -> no keyboard notice', async () => {
    const box = await makeBox()
    const r = await viaDashC(box, ['--help'])
    expect(r.stderr).not.toContain(NOTICE)
  })
})

// ============================================================ POSIX guard ===

describe('bootstrap.sh under sh', () => {
  test('`sh bootstrap.sh` -> exit 1 and the recommended command, literally', async () => {
    const box = await makeBox()
    const r = await exec(box, [SH, BOOTSTRAP])
    expect(r.tripped).toBe('')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('needs bash, not sh')
    expect(r.stderr.split('\n')).toContain(`  ${RECOMMENDED}`)
    expect(r.stderr).toContain(`curl -fsSL ${RAW} | sudo bash`)
  })

  test('`curl ... | sh` (script on stdin) -> the same', async () => {
    const box = await makeBox()
    const r = await exec(box, [SH], {}, await readFile(BOOTSTRAP, 'utf8'))
    expect(r.tripped).toBe('')
    expect(r.code).toBe(1)
    expect(r.stderr.split('\n')).toContain(`  ${RECOMMENDED}`)
  })
})

// ======================================================= keyboard notice ===

describe('bootstrap.sh early "No keyboard input" notice (tested through --help, which it precedes)', () => {
  const SUDO = { SUDO_USER: 'operator' }

  test('SUDO_USER set, stdin /dev/null, default repo/branch -> notice with the real copy-pasteable command', async () => {
    const box = await makeBox()
    const r = await viaDashC(box, ['--help'], SUDO)
    expectUsageOnly(r)
    const info = noticeLines(r)
    expect(info[0]).toMatch(/^INFO +No keyboard input available; .*skipped\.$/)
    expect(info.some((l) => l.endsWith(`use:  ${RECOMMENDED}`))).toBe(true)
    expect(info.some((l) => l.endsWith('sudo /opt/agentoo/install.sh --only https,summary'))).toBe(true)
    expect(r.stderr).not.toContain('<url of bootstrap.sh>')
    expect(r.stderr.indexOf(NOTICE)).toBeLessThan(r.stderr.indexOf(USAGE))
  })

  test('`curl | sudo bash -s -- --help` shape (script itself on stdin) -> the same notice', async () => {
    const box = await makeBox()
    const r = await exec(box, [BASH, '-s', '--', '--help'], SUDO, await readFile(BOOTSTRAP, 'utf8'))
    expectUsageOnly(r)
    expect(noticeLines(r).some((l) => l.endsWith(`use:  ${RECOMMENDED}`))).toBe(true)
  })

  test.each([
    ['--repo', ['--repo', 'https://example.org/fork.git', '--help'], {}],
    ['--branch', ['--branch', 'dev', '--help'], {}],
    ['REPO_URL env', ['--help'], { REPO_URL: 'https://example.org/fork.git' }],
    ['BRANCH env', ['--help'], { BRANCH: 'dev' }],
  ] as [string, string[], Record<string, string>][])(
    'customised source via %s -> placeholder, never the default raw URL',
    async (_label, args, env) => {
      const box = await makeBox()
      const r = await viaDashC(box, args, { ...SUDO, ...env })
      expectUsageOnly(r)
      expect(noticeLines(r).some((l) => l.endsWith(`use:  ${PLACEHOLDER}`))).toBe(true)
      expect(r.stderr).not.toContain(RAW)
    },
  )

  test('TARGET_DIR env -> the finish-later command uses that directory', async () => {
    const box = await makeBox()
    const r = await viaDashC(box, ['--help'], { ...SUDO, TARGET_DIR: '/srv/agentoo' })
    expectUsageOnly(r)
    expect(noticeLines(r).some((l) => l.endsWith('sudo /srv/agentoo/install.sh --only https,summary'))).toBe(true)
  })

  // Not in the task's stated contract, but the same line: an operator who
  // passed --dir is told to run an install.sh that is not where theirs is.
  test('--dir /srv/agentoo -> the finish-later command uses that directory', async () => {
    const box = await makeBox()
    const r = await viaDashC(box, ['--dir', '/srv/agentoo', '--help'], SUDO)
    expectUsageOnly(r)
    expect(r.stderr).not.toContain('/opt/agentoo/install.sh')
    expect(noticeLines(r).some((l) => l.endsWith('sudo /srv/agentoo/install.sh --only https,summary'))).toBe(true)
  })

  test.skipIf(!PYTHON)('SUDO_USER set but stdin a real pty (the recommended form) -> no notice', async () => {
    const box = await makeBox()
    const text = await readFile(BOOTSTRAP, 'utf8')
    const spec = JSON.stringify({ stdin: 'pty', timeout: 15 })
    const r = await exec(box, [PYTHON as string, PTY_RUN, spec, '--', BASH, '-c', `[[ -t 0 ]] && echo tty0 >&2\n${text}`, 'bootstrap', '--help'], SUDO)
    expect(r.stderr).toContain('tty0') // positive control: stdin really was a terminal
    expectUsageOnly(r)
    expect(r.stderr).not.toContain(NOTICE)
  })
})

// ================================================================= README ===

describe('README.md install instructions', () => {
  async function readme(): Promise<string> {
    return readFile(README, 'utf8')
  }
  function section(md: string, heading: string): string {
    const start = md.indexOf(heading)
    if (start < 0) return ''
    const level = /^#+/.exec(heading)?.[0] ?? '#'
    const rest = md.slice(start + heading.length)
    const next = rest.search(new RegExp(`^#{1,${level.length}} `, 'm'))
    return next < 0 ? rest : rest.slice(0, next)
  }

  test('the first command under "## Install" is the recommended sudo bash -c "$(curl ...)" form', async () => {
    const install = section(await readme(), '## Install')
    const firstBlock = /```\n([\s\S]*?)```/.exec(install)?.[1].trim()
    expect(firstBlock).toBe(RECOMMENDED)
  })

  test('the `| sudo bash` form is still shown, and said to be unable to ask questions', async () => {
    const install = section(await readme(), '## Install')
    const piped = install.indexOf(`curl -fsSL ${RAW} | sudo bash`)
    expect(piped).toBeGreaterThan(install.indexOf(RECOMMENDED))
    expect(install.slice(0, piped)).toMatch(/Still supported[\s\S]*cannot ask questions/)
  })

  test('"Your own domain (optional)" has the token steps and --only https,summary', async () => {
    const own = section(await readme(), '### Your own domain (optional)')
    expect(own).not.toBe('')
    expect(own).toContain('https://dash.cloudflare.com/profile/api-tokens')
    expect(own).toContain('"Edit zone DNS"')
    expect(own).toMatch(/Zone Resources: Include · Specific zone/)
    expect(own).toContain('sudo /opt/agentoo/install.sh --only https,summary')
  })
})
