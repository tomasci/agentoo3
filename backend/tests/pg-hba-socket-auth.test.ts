// The unix-socket hardening scripts/60-install-postgres.sh applies to
// pg_hba.conf: scripts/lib/common.sh's pg_hba_require_socket_password, run for
// real (the shipped common.sh and config.sh, sourced under their own
// `set -Eeuo pipefail` and ERR trap) against temp copies of the pg_hba.conf
// Ubuntu creates for a PostgreSQL 18 cluster (fixtures/pg-hba/, made by
// initdb --auth-local peer --auth-host scram-sha-256 plus pg_createcluster's
// own `local all postgres peer` insertion). Under gawk and under mawk, which
// is what `awk` is on a stock Ubuntu server.
//
// Then the same files go into a throwaway PostgreSQL cluster of our own (its
// own data directory, socket directory and port; never the box's server) to
// show what they do: with Ubuntu's default, a socket login as a role named
// like the OS user needs no password; with the managed rule it needs one.
//
// Nothing here runs as root or reaches /etc: a `sudo` on PATH is a tripwire.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { listen } from 'bun'
import { postgresBinDir } from './pg-cluster'

setDefaultTimeout(60_000)

const REPO = join(import.meta.dir, '..', '..')
const COMMON = join(REPO, 'scripts', 'lib', 'common.sh')
const CONFIG = join(REPO, 'scripts', 'lib', 'config.sh')
const POSTGRES_SH = join(REPO, 'scripts', '60-install-postgres.sh')
const FIXTURE = join(import.meta.dir, 'fixtures', 'pg-hba', 'ubuntu-pg18-default.conf')
const BASH = Bun.which('bash') ?? '/bin/bash'
const AWKS = ['gawk', 'mawk'].filter((a) => Bun.which(a))
const isRoot = process.getuid?.() === 0

const ROLE = 'agentoo'
const BEGIN = '# >>> agentoo managed: socket auth >>>'
const END = '# <<< agentoo managed: socket auth <<<'
const rule = (role: string) => `local   all             ${role.padEnd(39)} scram-sha-256`
const POSTGRES_PEER = 'local   all             postgres                                peer'
const ALL_PEER = 'local   all             all                                     peer'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const fixture = () => readFile(FIXTURE, 'utf8')

/** A PATH whose `awk` is `awkName`, with a `sudo` that only records it was called. */
async function binDir(awkName: string): Promise<{ bin: string; tripped: string }> {
  const box = await tempDir('agentoo-hba-bin-')
  const bin = join(box, 'bin')
  await mkdir(bin)
  await symlink(Bun.which(awkName) as string, join(bin, 'awk'))
  const tripped = join(box, 'TRIPPED')
  await writeFile(join(bin, 'sudo'), `#!${BASH}\nprintf 'sudo %s\\n' "$*" >>'${tripped}'\nexit 97\n`)
  await chmod(join(bin, 'sudo'), 0o755)
  return { bin, tripped }
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
  changed: string | undefined
}

/** Sources the real common.sh + config.sh and calls the helper on `file`. */
async function runHelper(
  file: string,
  role: string,
  opts: { awk: string; dryRun?: boolean },
): Promise<Run> {
  const { bin, tripped } = await binDir(opts.awk)
  const state = await tempDir('agentoo-hba-state-')
  const harness = join(state, 'harness.sh')
  await writeFile(
    harness,
    [
      `. '${COMMON}'`,
      `. '${CONFIG}'`,
      'pg_hba_require_socket_password "$1" "$2"',
      'echo "CHANGED=$PG_HBA_CHANGED"',
      '',
    ].join('\n'),
  )
  const proc = Bun.spawn([BASH, harness, file, role], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '/tmp',
      LOG_DIR: join(state, 'log'),
      STATE_DIR: join(state, 'state'),
      NO_COLOR: '1',
      ...(opts.dryRun ? { DRY_RUN: '1' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(await readFile(tripped, 'utf8').catch(() => '')).toBe('')
  return { code, stdout, stderr, changed: /CHANGED=(\d)/.exec(stdout)?.[1] }
}

/** A temp copy of `content`, 0640 like Ubuntu's. */
async function hbaFile(content: string): Promise<string> {
  const dir = await tempDir('agentoo-hba-')
  const file = join(dir, 'pg_hba.conf')
  await writeFile(file, content)
  await chmod(file, 0o640)
  return file
}

/** Active (non-comment, non-blank) lines, in order. */
const activeRules = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)

/** `text` with the managed block (markers included) taken out. */
function withoutBlock(text: string): string {
  const lines = text.split('\n')
  const b = lines.indexOf(BEGIN)
  const e = lines.indexOf(END)
  if (b === -1 || e < b) return text
  return [...lines.slice(0, b), ...lines.slice(e + 1)].join('\n')
}

/** The fixture with `extra` lines inserted just before the line `before`. */
async function fixtureWith(before: string, extra: string[]): Promise<string> {
  const lines = (await fixture()).split('\n')
  const at = lines.indexOf(before)
  expect(at).toBeGreaterThan(-1)
  return [...lines.slice(0, at), ...extra, ...lines.slice(at)].join('\n')
}

test('the fixture is Ubuntu PG18 default: postgres peer, then all peer, scram over TCP', async () => {
  expect(activeRules(await fixture())).toEqual([
    'local   all             postgres                                peer',
    'local   all             all                                     peer',
    'host    all             all             127.0.0.1/32            scram-sha-256',
    'host    all             all             ::1/128                 scram-sha-256',
    'local   replication     all                                     peer',
    'host    replication     all             127.0.0.1/32            scram-sha-256',
    'host    replication     all             ::1/128                 scram-sha-256',
  ])
  expect(AWKS.length).toBeGreaterThan(0)
})

describe.each(AWKS)('pg_hba_require_socket_password (awk = %s)', (awk) => {
  test('inserts the rule after `local all postgres peer` and before `local all all peer`, touching nothing else', async () => {
    const original = await fixture()
    const file = await hbaFile(original)
    const r = await runHelper(file, ROLE, { awk })
    expect(r.stderr).not.toContain('ERROR')
    expect(r.code).toBe(0)
    expect(r.changed).toBe('1')

    const after = await readFile(file, 'utf8')
    const lines = after.split('\n')
    const pg = lines.indexOf(POSTGRES_PEER)
    const begin = lines.indexOf(BEGIN)
    const ours = lines.indexOf(rule(ROLE))
    const end = lines.indexOf(END)
    const all = lines.indexOf(ALL_PEER)
    expect(pg).toBeGreaterThan(-1)
    expect(begin).toBeGreaterThan(pg)
    expect(ours).toBeGreaterThan(begin)
    expect(end).toBeGreaterThan(ours)
    expect(all).toBeGreaterThan(end)
    expect(lines.filter((l) => l === rule(ROLE))).toHaveLength(1)

    // Every other line, the postgres one included, is byte-for-byte what it was.
    expect(withoutBlock(after)).toBe(original)
    expect(activeRules(after).slice(0, 3)).toEqual([POSTGRES_PEER, rule(ROLE), ALL_PEER])

    expect((await stat(file)).mode & 0o777).toBe(0o640)
    expect(await readFile(`${file}.agentoo-bak`, 'utf8')).toBe(original)
    expect(r.stderr).toContain("now requires a password for unix-socket logins as 'agentoo'")
  })

  test('a second run changes nothing: same bytes, same inode, no rewrite', async () => {
    const file = await hbaFile(await fixture())
    expect((await runHelper(file, ROLE, { awk })).changed).toBe('1')
    const first = await readFile(file, 'utf8')
    const before = await stat(file)

    const r = await runHelper(file, ROLE, { awk })
    expect(r.code).toBe(0)
    expect(r.changed).toBe('0')
    expect(r.stderr).toContain("already requires a password for unix-socket logins as 'agentoo'")
    expect(await readFile(file, 'utf8')).toBe(first)
    const after = await stat(file)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test('a conflicting earlier rule for the role: the managed rule goes above it, the rule itself is kept and reported', async () => {
    // An operator's own trust line for the role, above even the postgres one.
    const conflict = 'local   all             agentoo                                 trust'
    const input = await fixtureWith('# DO NOT DISABLE!', [conflict, ''])
    const file = await hbaFile(input)
    const r = await runHelper(file, ROLE, { awk })
    expect(r.code).toBe(0)
    expect(r.changed).toBe('1')

    const after = await readFile(file, 'utf8')
    expect(withoutBlock(after)).toBe(input)
    expect(activeRules(after).slice(0, 4)).toEqual([rule(ROLE), conflict, POSTGRES_PEER, ALL_PEER])
    expect(after).toContain(`\n${POSTGRES_PEER}\n`)
    expect(r.stderr).toContain(`also has \`${conflict}\``)

    // And stays put on the next run.
    expect((await runHelper(file, ROLE, { awk })).changed).toBe('0')
  })

  test('a conflicting rule between the postgres line and `all peer`, with a quoted or listed role name', async () => {
    const input = await fixtureWith(ALL_PEER, [
      'local   all             otheruser                               trust',
      'local   replication     agentoo                                 trust',
      'local   agentoo         "agentoo",backup                        md5',
    ])
    const file = await hbaFile(input)
    const r = await runHelper(file, ROLE, { awk })
    expect(r.code).toBe(0)
    const active = activeRules(await readFile(file, 'utf8'))
    // otheruser cannot match agentoo, and replication lines only match
    // replication connections, so both stay above the managed rule.
    expect(active.slice(0, 5)).toEqual([
      POSTGRES_PEER,
      'local   all             otheruser                               trust',
      'local   replication     agentoo                                 trust',
      rule(ROLE),
      'local   agentoo         "agentoo",backup                        md5',
    ])
    expect(r.stderr).toContain('also has `local   agentoo         "agentoo",backup')
  })

  test('group, regex and include lines count as possibly matching', async () => {
    for (const line of [
      'local   all             +staff                                  peer',
      'local   all             /^agent                                 peer',
      'local   all             @users.txt                              peer',
      'include_dir conf.d',
    ]) {
      const file = await hbaFile(await fixtureWith(ALL_PEER, [line]))
      expect((await runHelper(file, ROLE, { awk })).code).toBe(0)
      const active = activeRules(await readFile(file, 'utf8'))
      expect(active.slice(0, 3)).toEqual([POSTGRES_PEER, rule(ROLE), line])
    }
  })

  test('a block left below `all peer` (moved by hand, or appended) is moved back above it', async () => {
    const stale = `${await fixture()}${BEGIN}\n${rule(ROLE)}\n${END}\n`
    const file = await hbaFile(stale)
    const r = await runHelper(file, ROLE, { awk })
    expect(r.changed).toBe('1')
    const after = await readFile(file, 'utf8')
    expect(after.split('\n').filter((l) => l === BEGIN)).toHaveLength(1)
    expect(activeRules(after).slice(0, 3)).toEqual([POSTGRES_PEER, rule(ROLE), ALL_PEER])
    expect(withoutBlock(after)).toBe(await fixture())
  })

  test('a renamed role replaces the block instead of adding a second one', async () => {
    const file = await hbaFile(await fixture())
    await runHelper(file, ROLE, { awk })
    const r = await runHelper(file, 'agentoo_app', { awk })
    expect(r.changed).toBe('1')
    const after = await readFile(file, 'utf8')
    expect(after.split('\n').filter((l) => l === BEGIN)).toHaveLength(1)
    expect(after).not.toContain(rule(ROLE))
    expect(activeRules(after).slice(0, 3)).toEqual([POSTGRES_PEER, rule('agentoo_app'), ALL_PEER])
  })

  test('no rule could match the role: the block is appended at the end', async () => {
    const input = 'local   all   postgres   peer\nhost    all   all   127.0.0.1/32   scram-sha-256\n'
    const file = await hbaFile(input)
    expect((await runHelper(file, ROLE, { awk })).code).toBe(0)
    const after = await readFile(file, 'utf8')
    expect(after.startsWith(input)).toBe(true)
    expect(activeRules(after).at(-1)).toBe(rule(ROLE))
  })

  test('an unterminated managed block is refused, not truncated', async () => {
    const input = await fixtureWith(ALL_PEER, [BEGIN, rule(ROLE)])
    const file = await hbaFile(input)
    const r = await runHelper(file, ROLE, { awk })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('with no')
    expect(await readFile(file, 'utf8')).toBe(input)
  })
})

test('role names pg_hba.conf would misread are refused, and the file is left alone', async () => {
  const awk = AWKS[0] as string
  const original = await fixture()
  for (const role of ['all', 'samerole', 'replication', 'two words', 'a,b', '"quoted"', '+group', '']) {
    const file = await hbaFile(original)
    const r = await runHelper(file, role, { awk })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('Refusing to write a pg_hba.conf rule')
    expect(await readFile(file, 'utf8')).toBe(original)
  }
})

test('DRY_RUN=1 leaves the file alone', async () => {
  const original = await fixture()
  const file = await hbaFile(original)
  const r = await runHelper(file, ROLE, { awk: AWKS[0] as string, dryRun: true })
  expect(r.code).toBe(0)
  expect(r.stderr).toContain("[dry-run] would require a password for unix-socket logins as 'agentoo'")
  expect(await readFile(file, 'utf8')).toBe(original)
})

// --- scripts/60-install-postgres.sh ----------------------------------------------

test('60-install-postgres.sh: SCRAM password on stdin, then the rule, a parse check and a reload', async () => {
  const text = await Bun.file(POSTGRES_SH).text()
  // No password on a psql command line any more.
  expect(text).not.toMatch(/-c "[^"]*PASSWORD '\$pw/)
  expect(text).toContain("SET password_encryption = 'scram-sha-256';")
  expect(text).toContain("rolpassword LIKE 'SCRAM-SHA-256")
  const lines = text.split('\n')
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle))
  const role = at('ROLE "$POSTGRES_USER" WITH LOGIN PASSWORD')
  const hba = at("SHOW hba_file")
  const call = at('pg_hba_require_socket_password "$hba_file" "$POSTGRES_USER"')
  const reload = at('pg_reload_conf()')
  const socketCheck = at('can still log in over $sock_dir without a password')
  expect(role).toBeGreaterThan(-1)
  expect(hba).toBeGreaterThan(role)
  expect(call).toBeGreaterThan(hba)
  expect(reload).toBeGreaterThan(call)
  expect(socketCheck).toBeGreaterThan(reload)
})

/**
 * 60-install-postgres.sh's own pg_login_refused_for_password, cut out of the
 * script verbatim and run under the installer's `set -Eeuo pipefail`: whether
 * the stderr of the no-password socket login counts as the refusal the
 * self-check wants.
 */
async function refusedForPassword(stderr: string): Promise<boolean> {
  const text = await Bun.file(POSTGRES_SH).text()
  const fn = /^pg_login_refused_for_password\(\) \{\n[\s\S]*?\n\}\n/m.exec(text)?.[0]
  expect(fn).toBeDefined()
  const proc = Bun.spawn(
    [BASH, '-c', `set -Eeuo pipefail\n${fn}\npg_login_refused_for_password "$1"`, 'harness', stderr],
    { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
  )
  const [errors, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect(errors).toBe('')
  expect([0, 1]).toContain(code)
  return code === 0
}

describe("60-install-postgres.sh's no-password check only passes on an authentication failure", () => {
  const SOCKET = 'connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed'
  test.each([
    // psql -w against the scram-sha-256 rule: what the check expects to see.
    `psql: error: ${SOCKET}: fe_sendauth: no password supplied`,
    `psql: error: ${SOCKET}: FATAL:  password authentication failed for user "agentoo"`,
    `psql: error: ${SOCKET}: error received from server in SCRAM exchange: invalid-proof`,
  ])('refused for want of a password: %s', async (stderr) => {
    expect(await refusedForPassword(stderr)).toBe(true)
  })

  test.each([
    `psql: error: ${SOCKET}: No such file or directory\n\tIs the server running locally and accepting connections on that socket?`,
    'psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused',
    `psql: error: ${SOCKET}: FATAL:  Peer authentication failed for user "agentoo"`,
    `psql: error: ${SOCKET}: FATAL:  database "agentoo" does not exist`,
    `psql: error: ${SOCKET}: FATAL:  no pg_hba.conf entry for host "[local]", user "agentoo", database "agentoo", no encryption`,
    `psql: error: ${SOCKET}: FATAL:  pg_hba.conf rejects connection for host "[local]", user "agentoo", database "agentoo", no encryption`,
    'runuser: user agentoo does not exist or the user entry does not contain all the required fields',
    'bash: psql: command not found',
    '',
  ])('any other failure is not: %s', async (stderr) => {
    expect(await refusedForPassword(stderr)).toBe(false)
  })
})

;(isRoot ? test.skip : test)('60-install-postgres.sh with DRY_RUN=1 runs no psql and edits nothing', async () => {
  const box = await tempDir('agentoo-hba-dry-')
  const bin = join(box, 'bin')
  await mkdir(bin)
  const trip = join(box, 'TRIPPED')
  for (const t of ['psql', 'sudo', 'runuser', 'systemctl', 'apt-get', 'createdb', 'pg_ctl']) {
    await writeFile(join(bin, t), `#!${BASH}\nprintf '%s %s\\n' "${t}" "$*" >>"${trip}"\nexit 97\n`)
    await chmod(join(bin, t), 0o755)
  }
  const proc = Bun.spawn([BASH, POSTGRES_SH], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '/tmp',
      DRY_RUN: '1',
      LOG_DIR: join(box, 'log'),
      STATE_DIR: join(box, 'state'),
      ENV_FILE: join(box, '.env'),
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("[dry-run] would require a password for unix-socket logins as 'agentoo'")
  const calls = (await readFile(trip, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l && l !== 'sudo -n true')
  expect(calls).toEqual([])
})

// --- what the rule does to a real server ---------------------------------------

const bin = postgresBinDir()
const me = userInfo().username
const canLive = Boolean(bin) && !isRoot && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(me)

function freePort(): number {
  const probe = listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/** Runs a client binary with an environment of exactly `env` plus PATH/HOME. */
async function client(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PGPASSFILE: '/dev/null/no-pgpass', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

;(canLive ? describe : describe.skip)('against a throwaway PostgreSQL cluster', () => {
  const PASSWORD = `pw-${process.pid}`
  const SUPER_PASSWORD = `su-${process.pid}`
  let data = ''
  let sockets = ''
  let port = 0

  afterAll(async () => {
    if (data) await client([join(bin as string, 'pg_ctl'), '-D', data, '-m', 'immediate', '-w', 'stop'])
  })

  /** psql over the cluster's own unix socket, as `me`, never anywhere else. */
  const socketLogin = (password?: string) =>
    client(
      [join(bin as string, 'psql'), '-X', '-w', '-h', sockets, '-p', String(port), '-U', me, '-d', 'postgres', '-tAc', 'select 1'],
      password ? { PGPASSWORD: password } : {},
    )

  /** As the cluster's superuser over TCP, with its password (host rules are scram). */
  const superQuery = (sql: string) =>
    client(
      [join(bin as string, 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-tAc', sql],
      { PGPASSWORD: SUPER_PASSWORD },
    )

  /** Puts `content` in as the cluster's pg_hba.conf, reloads, and waits until `ready` says it took. */
  async function useHba(content: string, ready: () => Promise<boolean>) {
    await writeFile(join(data, 'pg_hba.conf'), content)
    const reload = await client([join(bin as string, 'pg_ctl'), '-D', data, 'reload'])
    expect(reload.code).toBe(0)
    for (let i = 0; i < 50; i++) {
      if (await ready()) return
      await Bun.sleep(100)
    }
    throw new Error('the reloaded pg_hba.conf never took effect')
  }

  test('setup: initdb, start, a role named like the OS user, passwords for both', async () => {
    const dir = await tempDir('agentoo-hba-pg-')
    data = join(dir, 'data')
    sockets = join(dir, 'sockets')
    await mkdir(sockets)
    port = freePort()
    const init = await client([join(bin as string, 'initdb'), '-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'])
    expect(init.code).toBe(0)
    const start = await client([
      join(bin as string, 'pg_ctl'), '-D', data, '-o', `-p ${port} -h 127.0.0.1 -k ${sockets} -c fsync=off`,
      '-l', join(dir, 'server.log'), '-w', '-t', '30', 'start',
    ])
    expect(start.code).toBe(0)
    const setup = await client(
      [join(bin as string, 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sockets, '-p', String(port), '-U', 'postgres', '-d', 'postgres',
        '-c', `create role "${me}" login password '${PASSWORD}'`,
        '-c', `alter role postgres password '${SUPER_PASSWORD}'`],
    )
    expect(setup.stderr).toBe('')
    expect(setup.code).toBe(0)
  })

  test("with Ubuntu's default pg_hba.conf, the OS user's socket login needs no password: the hole", async () => {
    await useHba(await fixture(), async () => (await superQuery('select 1')).code === 0)
    const r = await socketLogin()
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('1')
  })

  test('with the managed rule: no password is refused, the password works, the file parses cleanly', async () => {
    const file = await hbaFile(await fixture())
    expect((await runHelper(file, me, { awk: AWKS[0] as string })).changed).toBe('1')
    await useHba(await readFile(file, 'utf8'), async () => (await socketLogin()).code !== 0)

    const without = await socketLogin()
    expect(without.code).not.toBe(0)
    expect(without.stderr).toContain('no password supplied')
    const withPassword = await socketLogin(PASSWORD)
    expect(withPassword.stderr).toBe('')
    expect(withPassword.stdout.trim()).toBe('1')

    const errors = await superQuery('select count(*) from pg_hba_file_rules where error is not null')
    expect(errors.stdout.trim()).toBe('0')
    // The first socket rules, as the server itself reads them: postgres's
    // peer line still first, then ours, then everyone else's peer.
    const order = await superQuery(
      "select string_agg(array_to_string(user_name, ',') || ':' || auth_method, ' ' order by rule_number) from (select * from pg_hba_file_rules where type = 'local' order by rule_number limit 3) r",
    )
    expect(order.stdout.trim()).toBe(`postgres:peer ${me}:scram-sha-256 all:peer`)
  })

  /**
   * The installer's own "unix-socket auth" section, cut out of
   * 60-install-postgres.sh verbatim and run against this cluster: psql_super
   * is the cluster's superuser over TCP instead of `sudo -u postgres psql`,
   * as_user runs the command as this same OS user (which is the role), and
   * SHOW hba_file points the section at this cluster's own pg_hba.conf.
   * `asUser` replaces that as_user, for a test that needs the command it runs
   * to go wrong.
   */
  async function runSection(asUser = 'as_user() { shift; "$@"; }'): Promise<Run> {
    const lines = (await Bun.file(POSTGRES_SH).text()).split('\n')
    const start = lines.findIndex((l) => l.startsWith('# --- unix-socket auth'))
    const end = lines.findIndex((l) => l.startsWith('log_ok "PostgreSQL ready'))
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const state = await tempDir('agentoo-hba-section-')
    const harness = join(state, 'harness.sh')
    await writeFile(
      harness,
      [
        `. '${COMMON}'`,
        `. '${CONFIG}'`,
        `POSTGRES_USER='${me}'`,
        "POSTGRES_DB='postgres'",
        `pw='${PASSWORD}'`,
        `psql_super() { PGPASSWORD='${SUPER_PASSWORD}' PGPASSFILE=/dev/null/no-pgpass psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p ${port} -U postgres -d postgres "$@"; }`,
        asUser,
        ...lines.slice(start, end),
        'echo "CHANGED=$PG_HBA_CHANGED"',
        '',
      ].join('\n'),
    )
    const proc = Bun.spawn([BASH, harness], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? '/tmp',
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
    return { code, stdout, stderr, changed: /CHANGED=(\d)/.exec(stdout)?.[1] }
  }

  test("60-install-postgres.sh's socket section, end to end: edit, parse check, reload, both logins checked", async () => {
    await useHba(await fixture(), async () => (await socketLogin()).code === 0)
    const first = await runSection()
    expect(first.stderr).not.toContain('ERROR')
    expect(first.code).toBe(0)
    expect(first.changed).toBe('1')
    // The role's OS user exists here (it is us), so the no-password login was
    // actually tried and refused, not skipped.
    expect(first.stderr).toContain(`Unix-socket logins as '${me}' need its password\n`)
    expect((await socketLogin()).stderr).toContain('no password supplied')
    const written = await readFile(join(data, 'pg_hba.conf'), 'utf8')
    expect(withoutBlock(written)).toBe(await fixture())

    const again = await runSection()
    expect(again.code).toBe(0)
    expect(again.changed).toBe('0')
    expect(await readFile(join(data, 'pg_hba.conf'), 'utf8')).toBe(written)
  })

  test("60-install-postgres.sh's socket section: a no-password login failing for any other reason fails the check", async () => {
    await useHba(await fixture(), async () => (await superQuery('select 1')).code === 0)
    // The login without a password goes to a socket directory that does not
    // exist (psql takes the last -h): it fails, but proves nothing.
    const r = await runSection('as_user() { shift; "$@" -h /nonexistent/agentoo-no-socket; }')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(
      `Could not confirm that unix-socket logins as '${me}' need its password: the login without one failed, but not on authentication:`,
    )
    expect(r.stderr).toContain('/nonexistent/agentoo-no-socket/.s.PGSQL.')
    expect(r.stderr).toContain('No such file or directory')
    expect(r.stderr).not.toContain(`Unix-socket logins as '${me}' need its password\n`)
    await useHba(await fixture(), async () => (await socketLogin()).code === 0)
  })

  test("60-install-postgres.sh's socket section refuses a pg_hba.conf that already has errors", async () => {
    await useHba(await fixture(), async () => (await superQuery('select 1')).code === 0)
    const broken = `${await fixture()}local   all\n`
    await writeFile(join(data, 'pg_hba.conf'), broken)
    const r = await runSection()
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('has errors PostgreSQL cannot load')
    expect(await readFile(join(data, 'pg_hba.conf'), 'utf8')).toBe(broken)
    await writeFile(join(data, 'pg_hba.conf'), await fixture())
  })

  test("with an operator's earlier `trust` line for the role, no password is still refused", async () => {
    const conflict = `local   all             ${me.padEnd(39)} trust`
    const file = await hbaFile(await fixtureWith('# DO NOT DISABLE!', [conflict]))
    await runHelper(file, me, { awk: AWKS[0] as string })
    await useHba(await readFile(file, 'utf8'), async () => (await socketLogin()).code !== 0)
    expect((await socketLogin()).stderr).toContain('no password supplied')
    expect((await socketLogin(PASSWORD)).stdout.trim()).toBe('1')
  })
})
