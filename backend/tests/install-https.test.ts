// The optional custom-domain HTTPS feature of the installer, run for real —
// scripts/85-configure-https.sh, the TLS half of scripts/66-install-nginx.sh,
// the HTTPS block of scripts/90-summary.sh and the helpers they share in
// scripts/lib/common.sh — against a sandbox, never against this machine.
//
// Every run happens inside its own mktemp dir with:
//   - PATH = <fakes>:<tools>, and nothing else. <fakes> holds stand-ins for
//     every privileged or networked binary (sudo, certbot, curl, nginx,
//     systemctl, tailscale, apt-get, dig, ...; see fixtures/install-https/fakes).
//     <tools> holds symlinks to a fixed list of ordinary userland tools (sed,
//     jq, install, ...). So a code path that reaches for anything not on that
//     list fails with "command not found" — which run() treats as a test
//     failure — instead of reaching the real thing.
//   - every seam pointed into the sandbox: STATE_DIR, SETTINGS_FILE, LOG_DIR,
//     LOG_FILE, NGINX_CONF_DIR, LETSENCRYPT_DIR, PROMPT_TTY, ENV_FILE.
//   - the fake sudo refusing (and recording) any argument under the real /etc;
//     run() fails the test if that ever happens.
// The tests run unprivileged, so scripts/lib/common.sh picks _SUDO=(sudo) and
// the fake sudo is what every as_root goes through.

import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

setDefaultTimeout(60_000)

const REPO = join(import.meta.dir, '..', '..')
const SCRIPTS = join(REPO, 'scripts')
const NGINX_SH = join(SCRIPTS, '66-install-nginx.sh')
const HTTPS_SH = join(SCRIPTS, '85-configure-https.sh')
const SUMMARY_SH = join(SCRIPTS, '90-summary.sh')
const FAKES = join(import.meta.dir, 'fixtures', 'install-https', 'fakes')
// Gives a run a REAL pseudo-terminal (stdin and/or controlling tty) — see the
// header of that file. Resolved here, from the host PATH: inside a sandbox
// `python3` is only the version-tool stand-in.
const PTY_RUN = join(import.meta.dir, 'fixtures', 'install-https', 'pty-run.py')
const PYTHON = Bun.which('python3')

const TOKEN = 'tok_SECRET_abcdefghijklmnop1234'
const DOMAIN = 'ai.example.com'
const EMAIL = 'ops@example.com'
const TS_IP = '100.101.102.103'
const TS_NAMES = 'host.tailnet.ts.net 100.101.102.103 fd7a:115c:a1e0::1'
const SERVE_OURS =
  '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:80"}}}}}'
const SERVE_FOREIGN =
  '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:80"},"/grafana/":{"Proxy":"http://127.0.0.1:3001"}}}}}'
const RECIPE = 'HTTPS_DOMAIN=your.domain HTTPS_EMAIL=you@example.com CLOUDFLARE_API_TOKEN=...'

const BASH = Bun.which('bash') ?? '/usr/bin/bash'
const REAL_TOOLS = [
  'bash', 'env', 'cat', 'sed', 'awk', 'grep', 'jq', 'mktemp', 'install', 'ln', 'rm', 'mkdir',
  'chmod', 'date', 'head', 'tail', 'tr', 'sort', 'cut', 'dirname', 'basename', 'id', 'stat', 'cp',
  'mv', 'readlink', 'hostname', 'touch', 'wc', 'sleep', 'find', 'uname', 'true', 'false', 'test',
  '[', 'printf', 'tee', 'ls', 'xargs', 'cmp',
]
// 90-summary.sh only asks these for a version; one shared stand-in answers.
const VERSION_TOOLS = [
  'python3', 'pip3', 'uv', 'node', 'npm', 'bun', 'claude', 'git', 'wget', 'gcc', 'redis-cli', 'psql',
]
const FAKE_BINS = [
  'sudo', 'curl', 'certbot', 'nginx', 'tailscale', 'systemctl', 'dpkg-query', 'fuser', 'apt-get',
  'dig', 'getent', 'openssl', 'ufw',
]

// ------------------------------------------------------------------ sandbox --

interface Sandbox {
  root: string
  bin: string
  tools: string
  fake: string
  fakeState: string
  logDir: string
  stateDir: string
  settings: string
  nginx: string
  site: string
  le: string
  creds: string
  hook: string
  noTty: string
}

const sandboxes: string[] = []
afterAll(async () => {
  for (const d of sandboxes) await rm(d, { recursive: true, force: true })
})

async function makeSandbox(
  opts: { omitVersionTools?: string[]; serve?: string | null } = {},
): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'agentoo-https-test-'))
  sandboxes.push(root)
  const sb: Sandbox = {
    root,
    bin: join(root, 'bin'),
    tools: join(root, 'tools'),
    fake: join(root, 'fake'),
    fakeState: join(root, 'fakestate'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    settings: join(root, 'state', 'settings.env'),
    nginx: join(root, 'nginx'),
    site: join(root, 'nginx', 'sites-available', 'agentoo'),
    le: join(root, 'le'),
    creds: join(root, 'le', 'agentoo-cloudflare.ini'),
    hook: join(root, 'le', 'renewal-hooks', 'deploy', 'agentoo-reload-nginx'),
    noTty: join(root, 'no-such-tty'),
  }
  for (const d of [sb.bin, sb.tools, sb.fake, sb.fakeState, sb.logDir, sb.stateDir, sb.le]) {
    await mkdir(d, { recursive: true })
  }
  for (const sub of ['sites-available', 'sites-enabled', 'conf.d']) {
    await mkdir(join(sb.nginx, sub), { recursive: true })
  }
  await mkdir(join(root, 'home'), { recursive: true })
  await copyFile(join(FAKES, '_lib.sh'), join(sb.bin, '_lib.sh'))
  for (const f of FAKE_BINS) {
    await copyFile(join(FAKES, f), join(sb.bin, f))
    await chmod(join(sb.bin, f), 0o755)
  }
  for (const t of VERSION_TOOLS) {
    if (opts.omitVersionTools?.includes(t)) continue
    await copyFile(join(FAKES, 'version-tool'), join(sb.bin, t))
    await chmod(join(sb.bin, t), 0o755)
  }
  for (const t of REAL_TOOLS) {
    const p = Bun.which(t)
    if (!p) throw new Error(`test prerequisite missing on this host: ${t}`)
    await symlink(p, join(sb.tools, t))
  }
  // A box where an earlier nginx run already published itself via
  // `tailscale serve --bg 80` (the default).
  const serve = opts.serve === undefined ? SERVE_OURS : opts.serve
  if (serve !== null) await writeFile(join(sb.fakeState, 'serve.json'), `${serve}\n`)
  await writeFile(join(root, 'dotenv'), 'X=1\n')
  return sb
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
  calls: (name: string) => string[][]
  requests: string[]
  bodies: string[]
  headers: string
  /** -H @file arguments curl could not open (see the fake). */
  unreadableHeaders: string[]
  /** Killed for exceeding RunOpts.timeoutMs (or the pty driver's timeout). */
  timedOut: boolean
}

interface PtySpec {
  /** What fd 0 is: the pty itself (default), /dev/null, or an already-closed pipe. */
  stdin?: 'pty' | 'devnull' | 'pipe'
  /** Make the pty the controlling terminal, so open("/dev/tty") reaches it. */
  ctty?: boolean
  /** Lines typed into the pty; "noecho" waits for ECHO to be off first (a `read -s`). */
  type?: ['now' | 'noecho', string][]
  /** Where the pty's own display (terminal echo) is written. */
  echoLog?: string
  timeout?: number
}

interface RunOpts {
  /** Default 'ignore' (/dev/null). 'pipe' feeds stdinText then closes it. */
  stdin?: 'ignore' | 'pipe'
  stdinText?: string
  /** Run under pty-run.py instead; `stdin` is then ignored. */
  pty?: PtySpec
  /** Kill the run after this long; Run.timedOut says whether that happened. */
  timeoutMs?: number
}

async function readOr(p: string, fallback = ''): Promise<string> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return fallback
  }
}

function lines(s: string): string[] {
  return s.split('\n').filter((l) => l !== '')
}

async function run(
  sb: Sandbox,
  script: string,
  env: Record<string, string | undefined> = {},
  args: string[] = [],
  opts: RunOpts = {},
): Promise<Run> {
  // Per-run call logs; fakestate (tailscale serve) persists across runs.
  await rm(sb.fake, { recursive: true, force: true })
  await mkdir(join(sb.fake, 'calls'), { recursive: true })
  const base: Record<string, string> = {
    PATH: `${sb.bin}:${sb.tools}`,
    HOME: join(sb.root, 'home'),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    FAKE_DIR: sb.fake,
    FAKE_STATE: sb.fakeState,
    FAKE_CF_VALID_TOKEN: TOKEN,
    STATE_DIR: sb.stateDir,
    SETTINGS_FILE: sb.settings,
    LOG_DIR: sb.logDir,
    LOG_FILE: join(sb.logDir, 'install.log'),
    NGINX_CONF_DIR: sb.nginx,
    LETSENCRYPT_DIR: sb.le,
    PROMPT_TTY: sb.noTty,
    ENV_FILE: join(sb.root, 'dotenv'),
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  let argv = [BASH, script, ...args]
  if (opts.pty) {
    if (!PYTHON) throw new Error('python3 is needed on this host for pty scenarios')
    const spec = { timeout: (opts.timeoutMs ?? 20_000) / 1000, ...opts.pty }
    argv = [PYTHON, PTY_RUN, JSON.stringify(spec), '--', ...argv]
  }
  const usePipe = !opts.pty && opts.stdin === 'pipe'
  const proc = Bun.spawn(argv, {
    cwd: sb.root,
    env: base,
    stdin: usePipe ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (usePipe && proc.stdin && typeof proc.stdin !== 'number') {
    proc.stdin.write(opts.stdinText ?? '')
    proc.stdin.end()
  }
  let timedOut = false
  // Backstop for the pty driver's own timeout, and the only one otherwise.
  const killAfter = opts.timeoutMs === undefined ? undefined : opts.timeoutMs + (opts.pty ? 5_000 : 0)
  const timer =
    killAfter === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
        }, killAfter)
  const [stdout, stderr, rawCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
  // pty-run.py: 124 = timed out, 125 = a "noecho" line never saw ECHO go off.
  if (opts.pty && rawCode === 124) timedOut = true
  const code = rawCode

  // Safety net, checked on every run: nothing aimed at the real /etc, and
  // nothing reached for a binary the sandbox does not provide.
  expect(await readOr(join(sb.fake, 'BLOCKED'))).toBe('')
  expect(stderr).not.toContain('command not found')

  const callCache = new Map<string, string[][]>()
  for (const f of await readdir(join(sb.fake, 'calls'))) {
    const name = f.replace(/\.log$/, '')
    callCache.set(
      name,
      lines(await readFile(join(sb.fake, 'calls', f), 'utf8')).map((l) => JSON.parse(l)),
    )
  }
  return {
    code,
    stdout,
    stderr,
    calls: (name) => callCache.get(name) ?? [],
    requests: lines(await readOr(join(sb.fake, 'curl.requests'))),
    bodies: lines(await readOr(join(sb.fake, 'curl.bodies'))),
    headers: await readOr(join(sb.fake, 'curl.headers')),
    unreadableHeaders: lines(await readOr(join(sb.fake, 'curl.unreadable-header'))),
    timedOut,
  }
}

async function settingsOf(sb: Sandbox): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const l of lines(await readOr(sb.settings))) {
    const i = l.indexOf('=')
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1)
  }
  return out
}

async function writeSettings(sb: Sandbox, kv: Record<string, string>): Promise<void> {
  const body = Object.entries(kv)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('')
  await writeFile(sb.settings, body, { mode: 0o600 })
}

async function plantCert(sb: Sandbox, domain: string): Promise<void> {
  const dir = join(sb.le, 'live', domain)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'fullchain.pem'), `PLANTED FULLCHAIN ${domain}\n`)
  await writeFile(join(dir, 'privkey.pem'), `PLANTED PRIVKEY ${domain}\n`)
}

async function answers(sb: Sandbox, name: string, ...ls: string[]): Promise<string> {
  const p = join(sb.root, `answers-${name}`)
  await writeFile(p, ls.map((l) => `${l}\n`).join(''))
  return p
}

async function mode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777
}

async function serveState(sb: Sandbox): Promise<string> {
  return (await readOr(join(sb.fakeState, 'serve.json'), '')).trim()
}

/** Every file under `dir` as relative path -> content (symlinks as "-> target"). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(cur: string): Promise<void> {
    for (const e of await readdir(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      const rel = relative(dir, p)
      if (e.isSymbolicLink()) out[rel] = `-> ${await readlink(p)}`
      else if (e.isDirectory()) {
        out[`${rel}/`] = ''
        await walk(p)
      } else {
        const s = await stat(p)
        out[rel] = `${(s.mode & 0o777).toString(8)} ${s.mtimeMs} ${await readFile(p, 'utf8')}`
      }
    }
  }
  if (existsSync(dir)) await walk(dir)
  return out
}

/**
 * The token may live in exactly two places: the credentials file, and the
 * header file curl was handed (copied by the fake to curl.headers). Plus the
 * answers files the test itself wrote as input. Everything else in the
 * sandbox — logs, settings, every fake's argv log, nginx config — and the
 * script's stdout/stderr must not contain it.
 */
async function expectNoTokenLeak(sb: Sandbox, r: Run): Promise<void> {
  expect(r.stdout).not.toContain(TOKEN)
  expect(r.stderr).not.toContain(TOKEN)
  const exempt = new Set([sb.creds, join(sb.fake, 'curl.headers')])
  const leaks: string[] = []
  async function walk(cur: string): Promise<void> {
    for (const e of await readdir(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (p === sb.tools) continue
        await walk(p)
        continue
      }
      if (exempt.has(p) || e.name.startsWith('answers-')) continue
      if ((await readFile(p, 'utf8')).includes(TOKEN)) leaks.push(relative(sb.root, p))
    }
  }
  await walk(sb.root)
  expect(leaks).toEqual([])
  // Positive control: the log scan has something to scan.
  expect(existsSync(join(sb.logDir, 'install.log'))).toBe(true)
}

// ------------------------------------------------------------- site parsing --

/** Top-level `server { ... }` blocks, by brace matching. */
function serverBlocks(conf: string): string[] {
  const out: string[] = []
  const re = /^server \{$/gm
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = re.exec(conf))) {
    let depth = 0
    for (let i = m.index; i < conf.length; i++) {
      if (conf[i] === '{') depth++
      else if (conf[i] === '}') {
        depth--
        if (depth === 0) {
          out.push(conf.slice(m.index, i + 1))
          break
        }
      }
    }
  }
  return out
}

function locationBlock(server: string, loc: string): string {
  const start = server.indexOf(`    location ${loc} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < server.length; i++) {
    if (server[i] === '{') depth++
    else if (server[i] === '}') {
      depth--
      if (depth === 0) return server.slice(start, i + 1)
    }
  }
  return ''
}

function serverName(server: string): string {
  return /^\s*server_name (.*);$/m.exec(server)?.[1] ?? ''
}

function tailscaleCalls(r: Run): string[] {
  return r.calls('sudo').filter((a) => a[0] === 'tailscale').map((a) => a.join(' '))
}

function serveBgCalled(r: Run): boolean {
  return r.calls('tailscale').some((a) => a[0] === 'serve' && a[1] === '--bg' && a[2] === '80')
}

/** The structural contract for a TLS-on site file. */
function expectTlsSite(site: string, domain: string, le: string, defaultNames: string): void {
  const blocks = serverBlocks(site)
  const tls = blocks.filter((b) => /listen 443 ssl/.test(b))
  const dflt = blocks.filter((b) => b.includes('listen 80 default_server;'))
  const redirect = blocks.filter((b) => /^\s*listen 80;$/m.test(b))
  expect(tls).toHaveLength(1)
  expect(dflt).toHaveLength(1)
  expect(redirect).toHaveLength(1)

  expect(tls[0]).toMatch(/listen \[::\]:443 ssl/)
  expect(serverName(tls[0])).toBe(domain)
  expect(tls[0]).toContain(`ssl_certificate     ${le}/live/${domain}/fullchain.pem;`)
  expect(tls[0]).toContain(`ssl_certificate_key ${le}/live/${domain}/privkey.pem;`)

  expect(serverName(redirect[0])).toBe(domain)
  expect(redirect[0]).toContain(`return 301 https://${domain}$request_uri;`)

  expect(serverName(dflt[0]).split(' ')).not.toContain(domain)
  expect(serverName(dflt[0])).toBe(defaultNames)

  for (const loc of ['/api/', '/']) {
    const a = locationBlock(dflt[0], loc)
    const b = locationBlock(tls[0], loc)
    expect(a).not.toBe('')
    expect(b).toBe(a)
    expect(a).toContain('proxy_set_header Host              $host;')
    expect(a).toContain('proxy_set_header X-Forwarded-Proto $scheme;')
  }
}

// ------------------------------------------------ the pre-change 66, golden --
//
// The baseline for "a box with no custom domain sees no change" is a set of
// golden files under fixtures/install-https/golden/<scenario>/, rendered ONCE
// from commit 706d975 — the last commit before the HTTPS step was added — by
// extracting that commit's whole scripts/ tree, making the single edit
// "/etc/nginx" -> "${NGINX_CONF_DIR}" to its 66-install-nginx.sh (every
// occurrence was a path, never rendered content; its site heredoc was checked
// unchanged by that edit), and running it under this file's makeSandbox()/run()
// fakes and env for each scenario below. Per scenario:
//   sites-available-agentoo  the rendered site file
//   upgrade-map.conf         conf.d/upgrade-map.conf
//   tailscale.json           the `sudo tailscale ...` calls and whether
//                            `tailscale serve --bg 80` ran
// Nothing in them depends on the host or the sandbox path: server_name comes
// from the fake tailscale (or NGINX_DOMAIN), everything else from config.sh
// defaults under run()'s fixed env.
//
// Do NOT regenerate them from the current scripts: they are the pre-feature
// behaviour this test protects, so re-rendering them from the script under
// test would make the comparison pass by definition. They are also why this
// test reads no git ref at run time — any moving ref (the branch tip, main, a
// merge-base) moves past the feature commit and silently turns the baseline
// into the new code.
// Only if the no-domain output is changed ON PURPOSE should a golden file be
// edited, by hand, in the same change and with that reason stated.

const GOLDEN = join(import.meta.dir, 'fixtures', 'install-https', 'golden')

interface Golden {
  site: string
  upgradeMap: string
  sudoTailscaleCalls: string[]
  serveBgCalled: boolean
}

async function golden(scenario: string): Promise<Golden> {
  const dir = join(GOLDEN, scenario)
  const ts = JSON.parse(await readFile(join(dir, 'tailscale.json'), 'utf8'))
  return {
    site: await readFile(join(dir, 'sites-available-agentoo'), 'utf8'),
    upgradeMap: await readFile(join(dir, 'upgrade-map.conf'), 'utf8'),
    sudoTailscaleCalls: ts.sudoTailscaleCalls,
    serveBgCalled: ts.serveBgCalled,
  }
}

// ================================================================ install.sh ==

describe('install.sh --list', () => {
  test('shows the https step between ufw and summary', async () => {
    const sb = await makeSandbox()
    const r = await run(sb, join(REPO, 'install.sh'), {}, ['--list'])
    expect(r.code).toBe(0)
    const names = lines(r.stderr)
      .map((l) => /^ {2}(\S+)\s/.exec(l)?.[1])
      .filter((n): n is string => !!n)
    const ufw = names.indexOf('ufw')
    expect(ufw).toBeGreaterThan(-1)
    expect(names[ufw + 1]).toBe('https')
    expect(names[ufw + 2]).toBe('summary')
    expect(r.calls('sudo')).toEqual([])
  })
})

// ================================================================ common.sh ===

async function helper(
  sb: Sandbox,
  body: string,
  env: Record<string, string> = {},
  opts: RunOpts = {},
): Promise<Run> {
  const path = join(sb.root, `helper-${Math.random().toString(36).slice(2)}.sh`)
  await writeFile(
    path,
    [
      `. "${join(SCRIPTS, 'lib', 'common.sh')}"`,
      `. "${join(SCRIPTS, 'lib', 'config.sh')}"`,
      'set +e',
      body,
      '',
    ].join('\n'),
  )
  return run(sb, path, env, [], opts)
}

describe('common.sh helpers', () => {
  test('https_domain_valid accepts FQDNs and rejects everything the contract excludes', async () => {
    const sb = await makeSandbox()
    const valid = [
      'ai.example.com',
      'example.com',
      'a-b.example.co.uk',
      'xn--bcher-kva.example.com',
      `${'abcdefghi.'.repeat(25)}com`, // exactly 253
    ]
    const invalid = [
      'bad domain',
      '*.example.com',
      'a.ts.net',
      '100.1.2.3',
      'bücher.example.com',
      'AI.example.com',
      'localhost',
      '-a.example.com',
      'a-.example.com',
      'a..example.com',
      '',
      `${'a'.repeat(64)}.example.com`,
      `${'abcdefghi.'.repeat(25)}coma`, // 254
    ]
    const cases = [...valid, ...invalid]
    const body = cases
      .map((d, i) => `https_domain_valid ${JSON.stringify(d).replace(/^"|"$/g, "'")} && echo "${i} yes" || echo "${i} no"`)
      .join('\n')
    const r = await helper(sb, body)
    expect(r.code).toBe(0)
    const got = lines(r.stdout).map((l) => l.split(' ')[1])
    expect(got).toEqual([...valid.map(() => 'yes'), ...invalid.map(() => 'no')])
  })

  test('can_prompt is false under ASSUME_YES=1, DRY_RUN=1, and an unopenable PROMPT_TTY', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'cp', 'x')
    const body = 'can_prompt && echo yes || echo no'
    expect((await helper(sb, body, { PROMPT_TTY: file, ASSUME_YES: '1' })).stdout).toBe('no\n')
    expect((await helper(sb, body, { PROMPT_TTY: file, DRY_RUN: '1' })).stdout).toBe('no\n')
    const r = await helper(sb, `${body}\nlog_warn still-logging`, { PROMPT_TTY: sb.noTty })
    expect(r.stdout).toBe('no\n')
    // A failed open must not have swallowed the script's own stderr.
    expect(r.stderr).toContain('still-logging')
    expect((await helper(sb, body, { PROMPT_TTY: file })).stdout).toBe('yes\n')
  })

  test('several answers come from one regular file, one per line, in order', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'seq', 'first', '', 'third-secret')
    const r = await helper(
      sb,
      [
        'can_prompt || { echo cannot; exit 1; }',
        'can_prompt || { echo cannot2; exit 1; }', // idempotent: must not reopen/rewind
        'ask a "Q1"',
        'ask b "Q2" "dflt"',
        'ask_secret c "Q3"',
        'ask d "Q4" "end"',
        'printf "%s|%s|%s|%s\\n" "$a" "$b" "$c" "$d"',
      ].join('\n'),
      { PROMPT_TTY: file },
    )
    expect(r.stdout).toBe('first|dflt|third-secret|end\n')
    expect(r.stderr).toContain('Q1')
    expect(r.stderr).toContain('Q2 [dflt]')
    expect(r.stderr).not.toContain('third-secret')
  })

  test('https_cert_present needs both fullchain.pem and privkey.pem, non-empty', async () => {
    const sb = await makeSandbox()
    const body = 'https_cert_present ai.example.com && echo yes || echo no'
    expect((await helper(sb, body)).stdout).toBe('no\n')
    const dir = join(sb.le, 'live', DOMAIN)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'fullchain.pem'), 'x\n')
    expect((await helper(sb, body)).stdout).toBe('no\n')
    await writeFile(join(dir, 'privkey.pem'), '')
    expect((await helper(sb, body)).stdout).toBe('no\n')
    await writeFile(join(dir, 'privkey.pem'), 'k\n')
    expect((await helper(sb, body)).stdout).toBe('yes\n')
  })

  test('https_probe pins the name to 127.0.0.1:443 with curl --resolve', async () => {
    const sb = await makeSandbox()
    const ok = await helper(sb, 'https_probe ai.example.com && echo up || echo down')
    expect(ok.stdout).toBe('up\n')
    expect(ok.requests).toEqual(['PROBE ai.example.com:443:127.0.0.1 https://ai.example.com/'])
    const down = await helper(sb, 'https_probe ai.example.com && echo up || echo down', {
      FAKE_PROBE: 'fail',
    })
    expect(down.stdout).toBe('down\n')
  })
})

// ------------------------------------------- common.sh: the one prompt gate --
//
// Asking is allowed only if PROMPT_TTY opens AND (stdin is a terminal OR
// SUDO_USER is unset) — the `curl ... | sudo bash` case is SUDO_USER set with
// a pipe on stdin, where sudo never forwards keystrokes, so a read would hang.
// can_prompt() and confirm() must agree on that gate, and confirm() must never
// block or even open PROMPT_TTY when the gate is shut.

const UNDER_SUDO = { SUDO_USER: 'operator' }

/** A FIFO nobody ever writes to: open()ing it for reading blocks forever. */
async function neverWrittenFifo(sb: Sandbox): Promise<string> {
  const p = join(sb.root, `answers-fifo-${Math.random().toString(36).slice(2)}`)
  const r = Bun.spawnSync(['mkfifo', p])
  if (r.exitCode !== 0) throw new Error(`mkfifo failed: ${r.stderr}`)
  return p
}

const GATE = 'can_prompt && echo can || echo cannot'
const CONFIRM = 'confirm "Proceed" && echo yes || echo no'

describe('common.sh: can_prompt and confirm share one gate', () => {
  test('SUDO_USER set + stdin not a tty: can_prompt is false even though PROMPT_TTY opens', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'g1', 'y')
    const devnull = await helper(sb, GATE, { ...UNDER_SUDO, PROMPT_TTY: file })
    expect(devnull.stdout).toBe('cannot\n')
    const piped = await helper(sb, GATE, { ...UNDER_SUDO, PROMPT_TTY: file }, { stdin: 'pipe', stdinText: 'y\n' })
    expect(piped.stdout).toBe('cannot\n')
  })

  test('SUDO_USER unset + stdin not a tty + PROMPT_TTY opens: can_prompt is true (curl | bash as root)', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'g2', 'y')
    expect((await helper(sb, GATE, { PROMPT_TTY: file })).stdout).toBe('can\n')
    const piped = await helper(sb, GATE, { PROMPT_TTY: file }, { stdin: 'pipe', stdinText: 'junk\n' })
    expect(piped.stdout).toBe('can\n')
  })

  test.skipIf(!PYTHON)('SUDO_USER set + stdin a real pty: can_prompt is true', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'g3', 'y')
    const r = await helper(sb, `[[ -t 0 ]] && echo tty0\n${GATE}`, { ...UNDER_SUDO, PROMPT_TTY: file }, {
      pty: { stdin: 'pty' },
      timeoutMs: 15_000,
    })
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toBe('tty0\ncan\n')
  })

  test('confirm under ASSUME_YES=1 is yes at once, without asking, whatever the gate says', async () => {
    const sb = await makeSandbox()
    const fifo = await neverWrittenFifo(sb)
    for (const env of [
      { ASSUME_YES: '1', PROMPT_TTY: sb.noTty },
      { ASSUME_YES: '1', PROMPT_TTY: fifo, ...UNDER_SUDO },
    ]) {
      const r = await helper(sb, CONFIRM, env, { timeoutMs: 10_000 })
      expect(r.timedOut).toBe(false)
      expect(r.stdout).toBe('yes\n')
      expect(r.stderr).not.toContain('[y/N]')
    }
  })

  test('confirm with SUDO_USER set + stdin not a tty: no at once, without asking, and the "y" waiting in PROMPT_TTY is not taken', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'c1', 'y')
    const r = await helper(sb, CONFIRM, { ...UNDER_SUDO, PROMPT_TTY: file })
    expect(r.stdout).toBe('no\n')
    expect(r.stderr).not.toContain('[y/N]')
  })

  test('confirm with the gate shut never even opens PROMPT_TTY (a FIFO nobody writes would block the open)', async () => {
    const sb = await makeSandbox()
    const fifo = await neverWrittenFifo(sb)
    const started = Date.now()
    const r = await helper(sb, `${CONFIRM}\n${GATE}`, { ...UNDER_SUDO, PROMPT_TTY: fifo }, { timeoutMs: 10_000 })
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toBe('no\ncannot\n')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('confirm with an unopenable PROMPT_TTY (no terminal at all) is no, and logging still works', async () => {
    const sb = await makeSandbox()
    const r = await helper(sb, `${CONFIRM}\nlog_warn still-logging`, { PROMPT_TTY: sb.noTty })
    expect(r.stdout).toBe('no\n')
    expect(r.stderr).toContain('still-logging')
  })

  test('confirm reads the same once-opened fd as ask/ask_secret: answers are consumed in order across them', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'mix', 'y', 'first', 'n', 'secret-two', 'Y', 'maybe')
    const r = await helper(
      sb,
      [
        CONFIRM,
        'ask a "Q1"',
        CONFIRM,
        'ask_secret b "Q2"',
        'can_prompt || echo gate-disagrees',
        CONFIRM,
        CONFIRM, // "maybe" is not a yes
        CONFIRM, // EOF is not a yes either
        'printf "%s|%s\\n" "$a" "$b"',
      ].join('\n'),
      { PROMPT_TTY: file },
    )
    expect(r.stdout).toBe('yes\nno\nyes\nno\nno\nfirst|secret-two\n')
    expect(lines(r.stderr).join('\n').match(/\[y\/N\]/g)).toHaveLength(5)
  })

  test('confirm first, before any can_prompt, opens the fd itself; ask then gets the next line, not a rewind', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'first', 'y', 'second')
    const r = await helper(sb, `${CONFIRM}\nask a "Q"\necho "a=$a"`, { PROMPT_TTY: file })
    expect(r.stdout).toBe('yes\na=second\n')
  })

  test.skipIf(!PYTHON)(
    'the real bug shape: /dev/tty is a live pty but stdin is a pipe under sudo -> confirm is no, promptly',
    async () => {
      const sb = await makeSandbox()
      // Nothing is ever typed into the pty: a read on /dev/tty would block for
      // the full timeout — exactly the `curl | sudo bash` hang.
      const r = await helper(sb, `${CONFIRM}\n${GATE}`, { ...UNDER_SUDO, PROMPT_TTY: '/dev/tty' }, {
        pty: { stdin: 'pipe', ctty: true },
        timeoutMs: 10_000,
      })
      expect(r.timedOut).toBe(false)
      expect(r.stdout).toBe('no\ncannot\n')
    },
  )

  test.skipIf(!PYTHON)(
    'SUDO_USER set + stdin and /dev/tty a real pty (the `sudo bash -c "$(curl ...)"` shape): confirm reads the keyboard',
    async () => {
      const sb = await makeSandbox()
      const r = await helper(sb, `${CONFIRM}\n${CONFIRM}`, { ...UNDER_SUDO, PROMPT_TTY: '/dev/tty' }, {
        pty: { stdin: 'pty', ctty: true, type: [['now', 'y'], ['now', 'n']] },
        timeoutMs: 15_000,
      })
      expect(r.timedOut).toBe(false)
      expect(r.stdout).toBe('yes\nno\n')
    },
  )
})

// ============================================================ 66 (nginx) =====

describe('66-install-nginx.sh without a certified domain is byte-identical to before HTTPS (706d975)', () => {
  const cases: [string, string, Record<string, string>, Record<string, string>][] = [
    ['no HTTPS_DOMAIN at all', 'no-https-domain', {}, {}],
    ['HTTPS_DOMAIN=none (sticky)', 'https-domain-none', { HTTPS_DOMAIN: 'none' }, {}],
    ['HTTPS_DOMAIN set but no certificate', 'https-domain-without-cert', { HTTPS_DOMAIN: DOMAIN }, {}],
    ['explicit NGINX_DOMAIN', 'explicit-nginx-domain', {}, { NGINX_DOMAIN: 'box.example.org' }],
    ['tailscale down', 'tailscale-down', {}, { FAKE_TS_DOWN: '1' }],
  ]
  test.each(cases)('%s', async (_label, scenario, settings, env) => {
    const want = await golden(scenario)
    expect(want.site).toContain('listen 80 default_server;') // the golden file is a real render
    const sb = await makeSandbox()
    if (Object.keys(settings).length) await writeSettings(sb, settings)
    const r = await run(sb, NGINX_SH, env)
    expect(r.code).toBe(0)
    const site = await readFile(sb.site, 'utf8')
    expect(site).toBe(want.site)
    expect(site).not.toContain('443')
    expect(await readFile(join(sb.nginx, 'conf.d', 'upgrade-map.conf'), 'utf8')).toBe(want.upgradeMap)
    expect(await readlink(join(sb.nginx, 'sites-enabled', 'agentoo'))).toBe(sb.site)
    // Tailscale serve still published exactly as before (when tailscale is up).
    expect(serveBgCalled(r)).toBe(want.serveBgCalled)
    if (!env.FAKE_TS_DOWN) expect(serveBgCalled(r)).toBe(true)
    expect(tailscaleCalls(r)).toEqual(want.sudoTailscaleCalls)
    if (settings.HTTPS_DOMAIN === DOMAIN) {
      expect(r.stderr).toMatch(/WARN.*no certificate/)
      expect(r.stderr).toContain('--only https')
    }
  })

  test('the golden scenarios differ where their inputs differ (they are not one file five times)', async () => {
    const names = async (s: string) => serverName(serverBlocks((await golden(s)).site)[0])
    expect(await names('no-https-domain')).toBe(TS_NAMES)
    expect(await names('explicit-nginx-domain')).toBe('box.example.org')
    expect(await names('tailscale-down')).toBe('_')
    expect((await golden('tailscale-down')).sudoTailscaleCalls).toEqual([])
    expect((await golden('no-https-domain')).sudoTailscaleCalls).toEqual(['tailscale serve --bg 80'])
  })
})

describe('66-install-nginx.sh with a certified HTTPS_DOMAIN', () => {
  test('renders a TLS server, a redirect, frees :443 from our own tailscale serve, and skips serve --bg', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { TAILSCALE_SERVE: '1', FAKE_NGINX_VERSION: '1.28.3' })
    expect(r.code).toBe(0)
    const site = await readFile(sb.site, 'utf8')
    expectTlsSite(site, DOMAIN, sb.le, TS_NAMES)
    expect(site).toContain('    http2 on;')
    expect(site).toContain('    listen 443 ssl;')
    expect(site).not.toContain('ssl http2')
    expect(tailscaleCalls(r)).toEqual(['tailscale serve reset'])
    expect(serveBgCalled(r)).toBe(false)
    expect(await serveState(sb)).toBe('{}')
    expect(r.stderr).toContain(`https://${DOMAIN}/`)
  })

  test('nginx 1.18.0 gets `listen 443 ssl http2;` and no `http2 on;`', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { FAKE_NGINX_VERSION: '1.18.0' })
    expect(r.code).toBe(0)
    const site = await readFile(sb.site, 'utf8')
    expect(site).toContain('    listen 443 ssl http2;')
    expect(site).toContain('    listen [::]:443 ssl http2;')
    expect(site).not.toContain('http2 on;')
    expectTlsSite(site, DOMAIN, sb.le, TS_NAMES)
  })

  test('1.25.1 exactly counts as native http2', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { FAKE_NGINX_VERSION: '1.25.1' })
    expect(r.code).toBe(0)
    expect(await readFile(sb.site, 'utf8')).toContain('    http2 on;')
  })

  test('a foreign serve handler: `serve --https=443 off` (not reset), TLS on once 443 is free', async () => {
    const sb = await makeSandbox({ serve: SERVE_FOREIGN })
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH)
    expect(r.code).toBe(0)
    expect(tailscaleCalls(r)).toEqual(['tailscale serve --https=443 off'])
    expect(serveBgCalled(r)).toBe(false)
    expectTlsSite(await readFile(sb.site, 'utf8'), DOMAIN, sb.le, TS_NAMES)
  })

  test('a serve config with an extra TCP port is not "ours" either', async () => {
    const extra =
      '{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"host.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:80"}}}}}'
    const sb = await makeSandbox({ serve: extra })
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH)
    expect(r.code).toBe(0)
    expect(tailscaleCalls(r)).toEqual(['tailscale serve --https=443 off'])
  })

  test('443 still held after `serve --https=443 off` -> no TLS this run, with a warning', async () => {
    const sb = await makeSandbox({ serve: SERVE_FOREIGN })
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { FAKE_TS_OFF_STUCK: '1' })
    expect(r.code).toBe(0)
    expect(tailscaleCalls(r)[0]).toBe('tailscale serve --https=443 off')
    expect(await readFile(sb.site, 'utf8')).not.toContain('443')
    expect(r.stderr).toMatch(/WARN.*still holding :443/)
  })

  test('NGINX_DOMAIN == HTTPS_DOMAIN -> the default server falls back to the tailnet names', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { NGINX_DOMAIN: DOMAIN })
    expect(r.code).toBe(0)
    expectTlsSite(await readFile(sb.site, 'utf8'), DOMAIN, sb.le, TS_NAMES)
  })

  test('NGINX_DOMAIN == HTTPS_DOMAIN with tailscale down -> default server is `_`', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { NGINX_DOMAIN: DOMAIN, FAKE_TS_DOWN: '1' })
    expect(r.code).toBe(0)
    expectTlsSite(await readFile(sb.site, 'utf8'), DOMAIN, sb.le, '_')
  })

  test('nginx -t rejecting only the TLS config -> HTTP-only fallback, exit 0, serve --bg restored', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const r = await run(sb, NGINX_SH, { FAKE_NGINX_T: 'fail443' })
    expect(r.code).toBe(0)
    const site = await readFile(sb.site, 'utf8')
    expect(site).not.toContain('443')
    expect(serverName(serverBlocks(site)[0])).toBe(TS_NAMES)
    expect(serveBgCalled(r)).toBe(true)
    expect(r.stderr).toMatch(/WARN.*HTTP-only/)
    expect(r.calls('nginx').filter((a) => a[0] === '-t')).toHaveLength(2)
  })

  test('nginx -t always failing (TLS on) -> non-zero exit and the previous site file restored', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    await writeFile(sb.site, '# PREVIOUS SITE\n')
    const r = await run(sb, NGINX_SH, { FAKE_NGINX_T: 'fail' })
    expect(r.code).not.toBe(0)
    expect(await readFile(sb.site, 'utf8')).toBe('# PREVIOUS SITE\n')
    expect(r.calls('systemctl').filter((a) => a[0] === 'reload')).toEqual([])
  })

  test('nginx -t always failing (no domain) -> non-zero exit and the previous site file restored', async () => {
    const sb = await makeSandbox()
    await writeFile(sb.site, '# PREVIOUS SITE\n')
    const r = await run(sb, NGINX_SH, { FAKE_NGINX_T: 'fail' })
    expect(r.code).not.toBe(0)
    expect(await readFile(sb.site, 'utf8')).toBe('# PREVIOUS SITE\n')
  })

  test('DRY_RUN=1 writes nothing under NGINX_CONF_DIR and touches no tailscale state', async () => {
    const sb = await makeSandbox()
    await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN })
    await plantCert(sb, DOMAIN)
    const before = await snapshot(sb.nginx)
    const r = await run(sb, NGINX_SH, { DRY_RUN: '1' })
    expect(r.code).toBe(0)
    expect(await snapshot(sb.nginx)).toEqual(before)
    expect(await serveState(sb)).toBe(SERVE_OURS)
    expect(tailscaleCalls(r)).toEqual([])
    expect(r.calls('nginx').filter((a) => a[0] === '-t')).toEqual([])
    expect(r.stderr).toContain('[dry-run]')
  })
})

// ============================================================= 85 (https) ====

// scripts/85-configure-https.sh:73-79 builds curl's argv with the header file
// as a process substitution inside an array assignment:
//     local -a args=(... -H @<(printf 'Authorization: Bearer %s...' "$tok"))
// bash closes that /dev/fd/NN as soon as the assignment finishes, so by the
// time `curl "${args[@]}"` runs the file is gone and real curl exits 26
// ("option -H: error encountered when reading a file") before sending
// anything. The fake curl reproduces that faithfully by default, and the
// tests in "the Cloudflare token actually reaches curl" below run that way.
//
// Every OTHER scenario here goes through run85(), which sets
// FAKE_CURL_TOLERATE_UNREADABLE_HEADER=1: the fake then records the event and
// answers as though the header had carried the right token. That is the only
// way to exercise the DNS / certbot / settings / nginx logic that sits behind
// the defect. It is inert once the defect is fixed (the header becomes
// readable and is checked for real), and those scenarios never assert on the
// header itself.
function run85(
  sb: Sandbox,
  env: Record<string, string | undefined> = {},
  opts: RunOpts = {},
): Promise<Run> {
  return run(sb, HTTPS_SH, { FAKE_CURL_TOLERATE_UNREADABLE_HEADER: '1', ...env }, [], opts)
}

const OK_ENV = (extra: Record<string, string> = {}) => ({
  HTTPS_DOMAIN: DOMAIN,
  HTTPS_EMAIL: EMAIL,
  CLOUDFLARE_API_TOKEN: TOKEN,
  ASSUME_YES: '1',
  ...extra,
})

function certbotArgs(sb: Sandbox, domain: string, email: string): string[] {
  return [
    'certonly', '--dns-cloudflare',
    '--dns-cloudflare-credentials', sb.creds,
    '--dns-cloudflare-propagation-seconds', '30',
    '--cert-name', domain, '-d', domain,
    '--agree-tos', '-m', email, '--non-interactive', '--keep-until-expiring',
  ]
}

async function expectIssued(
  sb: Sandbox,
  r: Run,
  domain = DOMAIN,
  email = EMAIL,
  opts: { strict?: boolean } = {},
): Promise<void> {
  expect(r.code).toBe(0)
  const parent = domain.slice(domain.indexOf('.') + 1)
  expect(r.requests.slice(0, 3)).toEqual([
    `GET /zones?name=${domain}`,
    `GET /zones?name=${parent}`,
    `GET /zones/zone123/dns_records?name=${domain}`,
  ])
  if (opts.strict) {
    expect(r.unreadableHeaders).toEqual([])
    expect(r.headers).toContain(`Authorization: Bearer ${TOKEN}\n`)
  }
  expect(r.calls('certbot')).toEqual([certbotArgs(sb, domain, email)])
  expect(await readOr(join(sb.fake, 'certbot.creds-mode'))).toBe('600\n')
  expect(await readFile(sb.creds, 'utf8')).toBe(`dns_cloudflare_api_token = ${TOKEN}\n`)
  expect(await mode(sb.creds)).toBe(0o600)
  expect(await mode(sb.hook)).toBe(0o755)
  expect(await readFile(sb.hook, 'utf8')).toContain('nginx -t -q && systemctl reload nginx')
  const s = await settingsOf(sb)
  expect(s.HTTPS_DOMAIN).toBe(domain)
  expect(s.HTTPS_EMAIL).toBe(email)
  expect(Object.keys(s).filter((k) => k.includes('CLOUDFLARE'))).toEqual([])
  const site = await readFile(sb.site, 'utf8')
  expect(site).toContain('listen 443 ssl')
  expectTlsSite(site, domain, sb.le, TS_NAMES)
  expect(r.requests).toContain(`PROBE ${domain}:443:127.0.0.1 https://${domain}/`)
  await expectNoTokenLeak(sb, r)
}

function expectCreatedRecord(r: Run, domain = DOMAIN): void {
  const posts = r.bodies.filter((b) => b.startsWith('POST '))
  expect(posts).toHaveLength(1)
  const [, path, ...json] = posts[0].split(' ')
  expect(path).toBe('/zones/zone123/dns_records')
  const body = JSON.parse(json.join(' '))
  expect(body).toMatchObject({ type: 'A', name: domain, content: TS_IP, proxied: false })
  expect(r.requests.filter((q) => q.startsWith('PATCH '))).toEqual([])
}

function expectNothingAttempted(r: Run): void {
  expect(r.code).toBe(0)
  expect(r.requests).toEqual([])
  expect(r.calls('certbot')).toEqual([])
  expect(r.calls('apt-get')).toEqual([])
}

describe('85-configure-https.sh: the Cloudflare token actually reaches curl', () => {
  // These run the fake curl in its default, faithful mode: an @file it cannot
  // open is exit 26, exactly like real curl. See the note above run85().
  test('every Cloudflare call hands curl a readable -H @file carrying the bearer token', async () => {
    const sb = await makeSandbox()
    const r = await run(sb, HTTPS_SH, OK_ENV())
    expect(r.code).toBe(0)
    expect(r.calls('curl').length).toBeGreaterThan(0)
    expect(r.unreadableHeaders).toEqual([])
    expect(r.headers).toContain(`Authorization: Bearer ${TOKEN}\n`)
    await expectNoTokenLeak(sb, r)
  })

  test('unattended success, with a curl that behaves like the real one', async () => {
    const sb = await makeSandbox()
    const r = await run(sb, HTTPS_SH, OK_ENV())
    await expectIssued(sb, r, DOMAIN, EMAIL, { strict: true })
    expectCreatedRecord(r)
  })

  test('interactive success, with a curl that behaves like the real one', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'strict', DOMAIN, EMAIL, TOKEN)
    const r = await run(sb, HTTPS_SH, { PROMPT_TTY: file })
    await expectIssued(sb, r, DOMAIN, EMAIL, { strict: true })
    expectCreatedRecord(r)
  })
})

describe('85-configure-https.sh: skipping', () => {
  test('no tty and nothing set -> one line with the env recipe, nothing attempted, nothing saved', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb)
    expectNothingAttempted(r)
    expect(lines(r.stderr).filter((l) => l.includes(RECIPE))).toHaveLength(1)
    expect(lines(r.stderr).filter((l) => l.startsWith('INFO') && l.includes(RECIPE))).toHaveLength(1)
    expect(r.stderr).not.toMatch(/^(WARN|ERROR)/m)
    // No terminal at all is not the `curl | sudo bash` case: no sudo wording.
    expect(r.stderr).not.toMatch(PIPED_WORDING)
    expect(Object.keys(await settingsOf(sb)).filter((k) => k.startsWith('HTTPS_'))).toEqual([])
    await expectNoTokenLeak(sb, r)
  })

  test('ASSUME_YES=1 with an answers file present -> no prompt, answers not used', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'yes', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { ASSUME_YES: '1', PROMPT_TTY: file })
    expectNothingAttempted(r)
    expect(r.stderr).not.toContain('Domain to serve')
    expect(r.stderr).not.toContain('?')
    expect(Object.keys(await settingsOf(sb)).filter((k) => k.startsWith('HTTPS_'))).toEqual([])
    await expectNoTokenLeak(sb, r)
  })

  test('interactive, empty domain -> HTTPS_DOMAIN=none, and the next run does not ask again', async () => {
    const sb = await makeSandbox()
    const first = await run85(sb, { PROMPT_TTY: await answers(sb, 'empty', '') })
    expectNothingAttempted(first)
    expect(first.stderr).toContain('Domain to serve')
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBe('none')
    await expectNoTokenLeak(sb, first)

    const second = await run85(sb, {
      PROMPT_TTY: await answers(sb, 'second', DOMAIN, EMAIL, TOKEN),
    })
    expectNothingAttempted(second)
    expect(second.stderr).not.toContain('Domain to serve')
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBe('none')
    expect(existsSync(sb.site)).toBe(false)
    await expectNoTokenLeak(sb, second)
  })
})

// `curl ... | sudo bash`: SUDO_USER set, stdin a pipe. The prompt must be
// skipped (it could never be answered), with an explanation and the commands
// to finish later — and PROMPT_TTY must not be consumed, even when it opens.
const PIPED_WORDING = /piped into sudo|can't read keyboard input/

function expectPipedSkipBlock(r: Run): void {
  expect(r.code).toBe(0)
  expect(r.timedOut).toBe(false)
  const warn = lines(r.stderr).filter((l) => l.startsWith('WARN'))
  const text = warn.join('\n')
  expect(text).toContain("this run can't read keyboard input")
  expect(text).toContain('piped into sudo')
  expect(text).toMatch(/sudo \S*install\.sh --only https,summary$/m)
  expect(text).toMatch(/HTTPS_DOMAIN=your\.domain HTTPS_EMAIL=you@example\.com CLOUDFLARE_API_TOKEN=\.\.\. sudo \S*install\.sh --only https --yes$/m)
  expect(text).toMatch(/HTTPS_DOMAIN=none sudo \S*install\.sh --only https$/m)
  expect(r.stderr).not.toContain('Domain to serve')
  expect(r.stderr).not.toContain('?')
}

async function expectNothingSaved(sb: Sandbox): Promise<void> {
  expect(Object.keys(await settingsOf(sb)).filter((k) => k.startsWith('HTTPS_'))).toEqual([])
  expect(existsSync(sb.creds)).toBe(false)
}

describe('85-configure-https.sh: run piped into sudo (no keyboard can reach it)', () => {
  test('stdin /dev/null + SUDO_USER + a readable answers file -> skipped with the finish-later block, answers untouched', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'piped', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { ...UNDER_SUDO, PROMPT_TTY: file }, { timeoutMs: 20_000 })
    expectNothingAttempted(r)
    expectPipedSkipBlock(r)
    expect(r.calls('curl')).toEqual([])
    await expectNothingSaved(sb)
    await expectNoTokenLeak(sb, r)
  })

  test('stdin a pipe still carrying data (the rest of a curl stream) -> same skip; neither stdin nor PROMPT_TTY is read', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'piped2', DOMAIN, EMAIL, TOKEN)
    const r = await run85(
      sb,
      { ...UNDER_SUDO, PROMPT_TTY: file },
      { stdin: 'pipe', stdinText: `${DOMAIN}\n${EMAIL}\n${TOKEN}\n`, timeoutMs: 20_000 },
    )
    expectNothingAttempted(r)
    expectPipedSkipBlock(r)
    await expectNothingSaved(sb)
    await expectNoTokenLeak(sb, r)
  })

  test('PROMPT_TTY is a FIFO nobody writes -> still exits promptly (it is never opened)', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, { ...UNDER_SUDO, PROMPT_TTY: await neverWrittenFifo(sb) }, { timeoutMs: 15_000 })
    expectNothingAttempted(r)
    expectPipedSkipBlock(r)
    await expectNothingSaved(sb)
  })

  test.skipIf(!PYTHON)(
    'the reported hang: /dev/tty is a live pty nobody types into, stdin a pipe, SUDO_USER set -> exits 0 promptly',
    async () => {
      const sb = await makeSandbox()
      const r = await run85(sb, { ...UNDER_SUDO, PROMPT_TTY: '/dev/tty' }, {
        pty: { stdin: 'pipe', ctty: true },
        timeoutMs: 15_000,
      })
      expectNothingAttempted(r)
      expectPipedSkipBlock(r)
      await expectNothingSaved(sb)
    },
  )

  test('ASSUME_YES=1 under sudo with a pipe on stdin -> the --yes reason, not the "piped into sudo" one', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'yes-sudo', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { ...UNDER_SUDO, ASSUME_YES: '1', PROMPT_TTY: file })
    expectNothingAttempted(r)
    expect(r.stderr).not.toMatch(PIPED_WORDING)
    expect(r.stderr).not.toContain('Domain to serve')
    expect(lines(r.stderr).filter((l) => l.startsWith('INFO') && l.includes(RECIPE))).toHaveLength(1)
    expect(r.stderr).toContain('not --yes')
    expect(r.stderr).not.toMatch(/^(WARN|ERROR)/m)
    await expectNothingSaved(sb)
  })

  test('DRY_RUN=1 under sudo with a pipe on stdin -> the dry-run reason, not the "piped into sudo" one', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'dry-sudo', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { ...UNDER_SUDO, DRY_RUN: '1', PROMPT_TTY: file })
    expectNothingAttempted(r)
    expect(r.stderr).not.toMatch(PIPED_WORDING)
    expect(r.stderr).toContain('[dry-run] No HTTPS_DOMAIN configured')
    expect(r.stderr).not.toContain('Domain to serve')
    await expectNothingSaved(sb)
  })

  test('SUDO_USER unset + stdin a pipe + answers (curl | bash as root) -> prompts work as before, issued', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'root-pipe', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { PROMPT_TTY: file }, { stdin: 'pipe', stdinText: 'not-an-answer\n' })
    expect(r.stderr).toContain('Domain to serve')
    expect(r.stderr).not.toMatch(PIPED_WORDING)
    await expectIssued(sb, r)
    expectCreatedRecord(r)
  })

  test.skipIf(!PYTHON)('SUDO_USER set + stdin a real pty + answers file -> prompts work, issued', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'sudo-pty', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { ...UNDER_SUDO, PROMPT_TTY: file }, { pty: { stdin: 'pty' }, timeoutMs: 30_000 })
    expect(r.timedOut).toBe(false)
    expect(r.stderr).toContain('Domain to serve')
    expect(r.stderr).not.toMatch(PIPED_WORDING)
    await expectIssued(sb, r)
    expectCreatedRecord(r)
  })

  test.skipIf(!PYTHON)(
    'sudo bash -c "$(curl ...)" shape: SUDO_USER set, stdin and /dev/tty one real pty, typed answers -> issued, token never echoed',
    async () => {
      const sb = await makeSandbox()
      const echoLog = join(sb.root, 'pty-echo.log')
      const r = await run85(sb, { ...UNDER_SUDO, PROMPT_TTY: '/dev/tty' }, {
        pty: {
          stdin: 'pty',
          ctty: true,
          // The token is typed only once `read -s` has switched echo off —
          // what a human pasting at the hidden prompt actually does.
          type: [['now', DOMAIN], ['now', EMAIL], ['noecho', TOKEN]],
          echoLog,
        },
        timeoutMs: 30_000,
      })
      expect(r.timedOut).toBe(false)
      expect(r.code).not.toBe(125) // the hidden prompt really did turn echo off
      const echoed = await readOr(echoLog)
      expect(echoed).toContain(DOMAIN) // positive control: the echo capture works
      expect(echoed).not.toContain(TOKEN)
      await expectIssued(sb, r) // includes the stdout/stderr/log/argv leak scan, echo log included
      expectCreatedRecord(r)
    },
  )
})

describe('85-configure-https.sh: what the interactive prompts explain', () => {
  async function interactive(domain: string, extraEnv: Record<string, string> = {}, tokenAnswer = TOKEN) {
    const sb = await makeSandbox()
    const file = await answers(sb, 'guide', domain, EMAIL, tokenAnswer)
    return { sb, r: await run85(sb, { PROMPT_TTY: file, ...extraEnv }) }
  }

  test('before the domain prompt: the domain must be in your Cloudflare zone and will point at the Tailscale IP', async () => {
    const { sb, r } = await interactive(DOMAIN)
    const ask = r.stderr.indexOf('Domain to serve over HTTPS')
    expect(ask).toBeGreaterThan(-1)
    const zone = r.stderr.indexOf('Cloudflare zone you control')
    const dns = r.stderr.search(/DNS A record to point at this node's Tailscale IP/)
    expect(zone).toBeGreaterThan(-1)
    expect(dns).toBeGreaterThan(-1)
    expect(zone).toBeLessThan(ask)
    expect(dns).toBeLessThan(ask)
    await expectIssued(sb, r)
  })

  test("the email prompt says it is for Let's Encrypt expiry notices", async () => {
    const { r } = await interactive(DOMAIN)
    expect(r.stderr).toContain("Email for Let's Encrypt expiry notices: ")
  })

  test('before the token prompt: numbered steps, the right zone, not the Global API Key, input hidden', async () => {
    const { sb, r } = await interactive(DOMAIN)
    const email = r.stderr.indexOf("Email for Let's Encrypt")
    const tokenAsk = r.stderr.indexOf('Cloudflare API token (hidden): ')
    expect(email).toBeGreaterThan(-1)
    expect(tokenAsk).toBeGreaterThan(email)
    const guide = r.stderr.slice(email, tokenAsk)
    const steps = lines(guide)
      .map((l) => /^INFO\s+(\d)\. (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
    expect(steps.map((m) => m[1])).toEqual(['1', '2', '3', '4', '5'])
    expect(steps[0][2]).toContain('https://dash.cloudflare.com/profile/api-tokens')
    expect(steps[1][2]).toContain('Edit zone DNS')
    expect(steps[2][2]).toContain('"Zone / DNS / Edit"')
    expect(steps[3][2]).toContain('"Include / Specific zone / example.com"')
    expect(guide).toContain('Global API Key')
    expect(guide).toMatch(/input is hidden/)
    // Label: exactly "(hidden)" — no stored token, so no reuse offer.
    expect(r.stderr).not.toContain('reuse the saved token')
    await expectIssued(sb, r)
  })

  test.each([
    ['agentoo.skyparadise.org', 'skyparadise.org'],
    ['example.com', 'example.com'],
    ['a.b.example.com', 'example.com'],
  ])('zone hint for %s is %s (the last two labels)', async (domain, zone) => {
    const { sb, r } = await interactive(domain, { FAKE_CF_ZONE: zone })
    expect(r.stderr).toContain(`"Include / Specific zone / ${zone}"`)
    expect(r.stderr).not.toMatch(new RegExp(`Specific zone / (?!${zone.replaceAll('.', '\\.')}")`))
    expect(r.code).toBe(0)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBe(domain)
    await expectNoTokenLeak(sb, r)
  })

  test('a stored credentials file: the label offers Enter to reuse it, and Enter does', async () => {
    const sb = await makeSandbox()
    await writeFile(sb.creds, `dns_cloudflare_api_token = ${TOKEN}\n`, { mode: 0o600 })
    const r = await run85(sb, { PROMPT_TTY: await answers(sb, 'reuse', DOMAIN, EMAIL, '') })
    expect(r.stderr).toContain('Cloudflare API token (hidden; press Enter to reuse the saved token): ')
    expect(r.stderr).toContain('https://dash.cloudflare.com/profile/api-tokens')
    await expectIssued(sb, r)
  })

  test('zone lookup fails (interactive) -> the warning names Zone Resources, DNS Edit, API token vs Global API Key, and the retry', async () => {
    const { sb, r } = await interactive(DOMAIN, { FAKE_CF_ZONE: 'other.org' })
    expect(r.code).toBe(0)
    const warn = lines(r.stderr).filter((l) => l.startsWith('WARN')).join('\n')
    expect(warn).toContain(`Could not find a Cloudflare zone covering ${DOMAIN}`)
    expect(warn).toContain(`Zone Resources include the zone containing ${DOMAIN}`)
    expect(warn).toMatch(/Zone\W+DNS\W+Edit/)
    expect(warn).toContain('API token, not the Global API Key')
    expect(warn).toMatch(/Retry: +sudo \S*install\.sh --only https$/m)
    expect(r.calls('certbot')).toEqual([])
    await expectNothingSaved(sb)
    await expectNoTokenLeak(sb, r)
  })

  test('zone lookup fails with a certificate already present -> the same token checklist, DNS check skipped', async () => {
    const sb = await makeSandbox()
    await plantCert(sb, DOMAIN)
    const r = await run85(sb, OK_ENV({ FAKE_CF_ZONE: 'other.org' }))
    expect(r.code).toBe(0)
    const warn = lines(r.stderr).filter((l) => l.startsWith('WARN')).join('\n')
    expect(warn).toContain('skipping the DNS record check')
    expect(warn).toContain(`Zone Resources include the zone containing ${DOMAIN}`)
    expect(warn).toContain('API token, not the Global API Key')
    await expectNoTokenLeak(sb, r)
  })
})

describe('85-configure-https.sh: issuing', () => {
  test('interactive success', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'ok', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { PROMPT_TTY: file })
    expect(r.stderr).toContain('Domain to serve')
    expect(r.stderr).toContain('Cloudflare API token')
    await expectIssued(sb, r)
    expectCreatedRecord(r)
    expect(serveBgCalled(r)).toBe(false)
    expect(await serveState(sb)).toBe('{}')
  })

  test('interactive: a pasted "AI.Example.com." is normalised', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, {
      PROMPT_TTY: await answers(sb, 'norm', 'AI.Example.com.', EMAIL, TOKEN),
    })
    await expectIssued(sb, r)
  })

  test('unattended success (env + ASSUME_YES=1)', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV())
    await expectIssued(sb, r)
    expectCreatedRecord(r)
    expect(serveBgCalled(r)).toBe(false)
  })

  test('unattended success with VERBOSE=1 still keeps the token out of every log', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV({ VERBOSE: '1' }))
    expect(r.stderr).toContain('DEBUG')
    await expectIssued(sb, r)
  })

  test('token rejected by Cloudflare -> no certbot, no creds file, exit 0, domain not saved', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV({ FAKE_CF_VALID_TOKEN: 'some_other_token_0000000000', FAKE_CF_REJECT_ALL: '1' }))
    expect(r.code).toBe(0)
    expect(r.requests).toEqual([`GET /zones?name=${DOMAIN}`, 'GET /zones?name=example.com'])
    expect(r.calls('certbot')).toEqual([])
    expect(existsSync(sb.creds)).toBe(false)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBeUndefined()
    expect(r.stderr).toContain('--only https')
    await expectNoTokenLeak(sb, r)
  })

  test('valid token but no zone covering the domain -> same as rejected', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV({ FAKE_CF_ZONE: 'other.org' }))
    expect(r.code).toBe(0)
    expect(r.calls('certbot')).toEqual([])
    expect(existsSync(sb.creds)).toBe(false)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBeUndefined()
    await expectNoTokenLeak(sb, r)
  })

  test('certbot fails -> exit 0, retry command, creds kept, domain not saved, no 443', async () => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV({ FAKE_CERTBOT: 'fail' }))
    expect(r.code).toBe(0)
    expect(r.calls('certbot')).toHaveLength(1)
    expect(r.stderr).toMatch(/WARN.*--only https/)
    expect(await readFile(sb.creds, 'utf8')).toBe(`dns_cloudflare_api_token = ${TOKEN}\n`)
    expect(await mode(sb.creds)).toBe(0o600)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBeUndefined()
    expect((await readOr(sb.site)).includes('443')).toBe(false)
    expect(await serveState(sb)).toBe(SERVE_OURS)
    await expectNoTokenLeak(sb, r)
  })

  test('re-run with the domain saved and a cert present -> no certbot, no prompt, stored token, nginx untouched', async () => {
    const sb = await makeSandbox()
    await expectIssued(sb, await run85(sb, OK_ENV()))
    const siteBefore = await snapshot(join(sb.nginx))
    const r = await run85(sb, {
      PROMPT_TTY: await answers(sb, 'rerun', 'other.example.com', EMAIL, 'x'.repeat(30)),
    })
    expect(r.code).toBe(0)
    expect(r.calls('certbot')).toEqual([])
    expect(r.stderr).not.toContain('Domain to serve')
    expect(r.stderr).not.toContain('Cloudflare API token (')
    // The stored token was read back from the creds file (sed via sudo), was
    // usable (a zone lookup only happens with a non-empty, well-formed token),
    // and is byte-identical — the creds file is rewritten from it on this run.
    expect(r.calls('sudo').some((a) => a.includes('sed') && a.includes(sb.creds))).toBe(true)
    expect(await readFile(sb.creds, 'utf8')).toBe(`dns_cloudflare_api_token = ${TOKEN}\n`)
    expect(r.stderr).toMatch(/OK.*Cloudflare zone: example\.com/)
    expect(r.calls('nginx')).toEqual([])
    expect(await snapshot(join(sb.nginx))).toEqual(siteBefore)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBe(DOMAIN)
    await expectNoTokenLeak(sb, r)
  })

  test('domain change without a token -> token taken from the creds file', async () => {
    const sb = await makeSandbox()
    await expectIssued(sb, await run85(sb, OK_ENV()))
    const r = await run85(sb, { HTTPS_DOMAIN: 'new.example.com', ASSUME_YES: '1' })
    await expectIssued(sb, r, 'new.example.com', EMAIL)
  })
})

describe('85-configure-https.sh: invalid domains are rejected, nothing saved', () => {
  const bad = ['bad domain', '*.example.com', 'a.ts.net', '100.1.2.3', 'bücher.example.com']
  test.each(bad)('env HTTPS_DOMAIN=%p', async (d) => {
    const sb = await makeSandbox()
    const r = await run85(sb, OK_ENV({ HTTPS_DOMAIN: d }))
    expectNothingAttempted(r)
    expect(r.stderr).toMatch(/WARN.*not a valid domain/)
    expect(Object.keys(await settingsOf(sb)).filter((k) => k.startsWith('HTTPS_'))).toEqual([])
    expect(existsSync(sb.creds)).toBe(false)
    await expectNoTokenLeak(sb, r)
  })

  test('interactive: three invalid answers -> gives up, nothing saved', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'bad', 'bad domain', '*.example.com', 'a.ts.net', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { PROMPT_TTY: file })
    expectNothingAttempted(r)
    expect(lines(r.stderr).filter((l) => /WARN.*valid domain/.test(l))).toHaveLength(4)
    expect(Object.keys(await settingsOf(sb)).filter((k) => k.startsWith('HTTPS_'))).toEqual([])
    await expectNoTokenLeak(sb, r)
  })

  test('interactive: an invalid answer then a valid one -> proceeds with the valid one', async () => {
    const sb = await makeSandbox()
    const file = await answers(sb, 'retry', '100.1.2.3', DOMAIN, EMAIL, TOKEN)
    const r = await run85(sb, { PROMPT_TTY: file })
    await expectIssued(sb, r)
  })
})

describe('85-configure-https.sh: an existing A record', () => {
  async function withRecord(record: object): Promise<{ sb: Sandbox; r: Run }> {
    const sb = await makeSandbox()
    const p = join(sb.root, 'records.json')
    await writeFile(p, JSON.stringify({ success: true, errors: [], result: [record] }))
    const r = await run85(sb, OK_ENV({ FAKE_CF_RECORDS: p }))
    return { sb, r }
  }
  const rec = (content: string, proxied: boolean, extra: object = {}) => ({
    id: 'rec1', type: 'A', name: DOMAIN, content, proxied, ttl: 1, ...extra,
  })
  const writes = (r: Run) => r.requests.filter((q) => /^(POST|PATCH|PUT|DELETE) /.test(q))

  test('pointing at 203.0.113.9 (not ours) -> left alone with a warning, cert still issued', async () => {
    const { sb, r } = await withRecord(rec('203.0.113.9', false))
    expect(writes(r)).toEqual([])
    expect(r.stderr).toMatch(/WARN.*203\.0\.113\.9/)
    await expectIssued(sb, r)
  })

  test('pointing at 203.0.113.9 and proxied (not ours) -> still left alone', async () => {
    const { sb, r } = await withRecord(rec('203.0.113.9', true))
    expect(writes(r)).toEqual([])
    expect(r.stderr).toMatch(/WARN.*203\.0\.113\.9/)
    await expectIssued(sb, r)
  })

  test('pointing at an old tailnet IP 100.64.1.2, proxied -> PATCHed to our IP, DNS-only', async () => {
    const { sb, r } = await withRecord(rec('100.64.1.2', true))
    expect(writes(r)).toEqual(['PATCH /zones/zone123/dns_records/rec1'])
    const body = r.bodies.find((b) => b.startsWith('PATCH '))?.split(' ').slice(2).join(' ') ?? '{}'
    expect(JSON.parse(body)).toEqual({ content: TS_IP, proxied: false })
    await expectIssued(sb, r)
  })

  test('already our IP, not proxied -> neither POST nor PATCH', async () => {
    const { sb, r } = await withRecord(rec(TS_IP, false))
    expect(writes(r)).toEqual([])
    await expectIssued(sb, r)
  })
})

describe('85-configure-https.sh: disabling and dry runs', () => {
  test('HTTPS_DOMAIN=none after a configured domain -> none saved, no 443, serve --bg back, cert kept, delete hint', async () => {
    const sb = await makeSandbox()
    await expectIssued(sb, await run85(sb, OK_ENV()))
    const certBefore = await snapshot(join(sb.le, 'live'))
    const r = await run85(sb, { HTTPS_DOMAIN: 'none', ASSUME_YES: '1' })
    expect(r.code).toBe(0)
    expect((await settingsOf(sb)).HTTPS_DOMAIN).toBe('none')
    expect(await readFile(sb.site, 'utf8')).not.toContain('443')
    expect(serveBgCalled(r)).toBe(true)
    expect(await serveState(sb)).toBe(SERVE_OURS)
    expect(await snapshot(join(sb.le, 'live'))).toEqual(certBefore)
    expect(r.stderr).toContain(`certbot delete --cert-name ${DOMAIN}`)
    expect(r.calls('certbot')).toEqual([])
    expect(r.requests).toEqual([])
    await expectNoTokenLeak(sb, r)
  })

  test('DRY_RUN=1 with a full env -> no curl, no certbot, nothing written', async () => {
    const sb = await makeSandbox()
    const before = {
      nginx: await snapshot(sb.nginx),
      le: await snapshot(sb.le),
      state: await snapshot(sb.stateDir),
    }
    const r = await run85(sb, OK_ENV({ DRY_RUN: '1', ASSUME_YES: undefined }))
    expect(r.code).toBe(0)
    expect(r.calls('curl')).toEqual([])
    expect(r.calls('certbot')).toEqual([])
    expect(r.calls('sudo').filter((a) => a[0] !== 'test' && !(a[0] === '-n' && a[1] === 'test') && !(a[0] === '-n' && a[1] === 'true'))).toEqual([])
    expect(await snapshot(sb.nginx)).toEqual(before.nginx)
    expect(await snapshot(sb.le)).toEqual(before.le)
    expect(await snapshot(sb.stateDir)).toEqual(before.state)
    expect(await serveState(sb)).toBe(SERVE_OURS)
    await expectNoTokenLeak(sb, r)
  })

  test('DRY_RUN=1 disabling a configured domain -> settings and site unchanged', async () => {
    const sb = await makeSandbox()
    await expectIssued(sb, await run85(sb, OK_ENV()))
    const before = { nginx: await snapshot(sb.nginx), state: await snapshot(sb.stateDir) }
    const r = await run85(sb, { HTTPS_DOMAIN: 'none', DRY_RUN: '1' })
    expect(r.code).toBe(0)
    expect(await snapshot(sb.nginx)).toEqual(before.nginx)
    expect(await snapshot(sb.stateDir)).toEqual(before.state)
    await expectNoTokenLeak(sb, r)
  })
})

// =========================================================== 90 (summary) ====

describe('90-summary.sh HTTPS block', () => {
  // 'none': no HTTPS_DOMAIN key at all (never answered). 'disabled': HTTPS_DOMAIN=none.
  async function summary(
    state: 'none' | 'disabled' | 'certified' | 'uncertified',
    opts: { omitVersionTools?: string[]; probe?: 'ok' | 'fail' } = {},
  ): Promise<Run> {
    const sb = await makeSandbox({ omitVersionTools: opts.omitVersionTools })
    if (state === 'disabled') await writeSettings(sb, { HTTPS_DOMAIN: 'none' })
    else if (state !== 'none') await writeSettings(sb, { HTTPS_DOMAIN: DOMAIN, HTTPS_EMAIL: EMAIL })
    if (state === 'certified') await plantCert(sb, DOMAIN)
    return run(sb, SUMMARY_SH, { FAKE_PROBE: opts.probe ?? 'ok' })
  }
  const missingLines = (r: Run) => lines(r.stderr).filter((l) => /\bmissing$/.test(l))

  test('domain + cert + probe OK -> https://D/ listed with a Custom domain ok line; exit unchanged', async () => {
    const base = await summary('none')
    const r = await summary('certified')
    expect(base.code).toBe(0)
    expect(r.code).toBe(base.code)
    expect(missingLines(r)).toEqual(missingLines(base))
    expect(r.stderr).toMatch(new RegExp(`^OK +Custom domain: https://${DOMAIN.replaceAll('.', '\\.')}/$`, 'm'))
    expect(lines(r.stderr)).toContain(`    https://${DOMAIN}/`)
    expect(base.stderr).not.toContain('Custom domain')
    expect(base.stderr).not.toContain(DOMAIN)
  })

  test('domain saved but no cert -> warning suggesting --only https; exit unchanged', async () => {
    const base = await summary('none')
    const r = await summary('uncertified')
    expect(r.code).toBe(base.code)
    expect(missingLines(r)).toEqual(missingLines(base))
    expect(r.stderr).toMatch(/^WARN .*no certificate exists/m)
    expect(r.stderr).toMatch(/^WARN .*--only https$/m)
    expect(r.stderr).not.toContain('Custom domain')
  })

  const nextStep = (r: Run) => lines(r.stderr).filter((l) => /Next step|--only https,summary/.test(l))

  test('never answered -> a "Next step" line pointing at --only https,summary; exit and missing lines unchanged', async () => {
    const never = await summary('none')
    const disabled = await summary('disabled')
    expect(nextStep(never)).toHaveLength(2)
    expect(nextStep(never)[0]).toMatch(/^INFO +Next step: .*HTTPS on your own domain/)
    expect(nextStep(never)[1]).toMatch(/^INFO +sudo \S*install\.sh --only https,summary$/)
    expect(never.code).toBe(disabled.code)
    expect(never.code).toBe(0)
    expect(missingLines(never)).toEqual(missingLines(disabled))
  })

  test.each(['disabled', 'certified', 'uncertified'] as const)(
    'HTTPS_DOMAIN %s -> no "Next step" line',
    async (state) => {
      const r = await summary(state)
      expect(nextStep(r)).toEqual([])
    },
  )

  test('cert present but probe failing -> a warning, exit unchanged', async () => {
    const base = await summary('none')
    const r = await summary('certified', { probe: 'fail' })
    expect(r.code).toBe(base.code)
    expect(r.stderr).toMatch(/^WARN .*not answering/m)
  })

  test.skipIf(existsSync('/usr/local/bin/psql'))(
    'with one tool genuinely missing, every HTTPS state still reports exactly one missing and fails',
    async () => {
      const omit = { omitVersionTools: ['psql'] }
      const runs = [
        await summary('none', omit),
        await summary('disabled', omit),
        await summary('certified', omit),
        await summary('uncertified', omit),
      ]
      for (const r of runs) {
        expect(r.code).toBe(1)
        expect(missingLines(r)).toHaveLength(1)
        expect(r.stderr).toContain('1 expected tool(s) missing')
      }
    },
  )
})
