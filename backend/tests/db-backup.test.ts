// features/backups/dump.ts: naming, retention (with backups named in the
// future), the partial-then-rename write, the clean-up of partials a crash
// left, the free-space check and pg_dump's environment, against a real
// filesystem, fake statfs results and fake pg_dump scripts. No database: the real dump, the lock and the server-version check
// are covered by db-backup-db.test.ts against a throwaway cluster.
//
// Only dump.ts is imported, never service.ts: dump.ts reaches neither @/env
// nor @/db/client, which other files in this shared process replace with
// mocks of their own.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import './setup-env'
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyRetention,
  BackupError,
  backupChildEnv,
  backupFileName,
  CLOCK_SKEW_TOLERANCE_MS,
  dumpDatabase,
  ensureBackupsDir,
  ensureFreeSpace,
  insufficientSpaceMessage,
  listBackups,
  MIN_FREE_BYTES,
  parseBackupFileName,
  parsePgDumpVersion,
  pgDumpTooOldMessage,
  pgEnvFromDatabaseUrl,
  readFsSpace,
  readPgDumpVersion,
  removeOrphanedPartials,
  reservedBytes,
  splitByClock,
  type StatFs,
  versionMismatchFromStderr,
} from '../src/features/backups/dump'

const ROOT = `/tmp/agentoo-db-backup-unit-${process.pid}`
const SCRIPTS = join(ROOT, 'bin')
let dir = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  dir = join(ROOT, `case-${counter}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await mkdir(SCRIPTS, { recursive: true })
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

/** A stand-in for pg_dump: a shell script, mode 0755. */
async function fakePgDump(name: string, body: string): Promise<string> {
  const path = join(SCRIPTS, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/** Shell that finds pg_dump's --file= argument, into $out. */
const FIND_OUT = 'for a in "$@"; do case "$a" in --file=*) out="${a#--file=}";; esac; done'

const PASSWORD = 'pa:ss@w/rd-7f3c'
const URL_WITH_PASSWORD = `postgresql://agentoo:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/agentoo`
const childEnv = () => backupChildEnv(URL_WITH_PASSWORD, { PATH: process.env.PATH ?? '/usr/bin:/bin' })

// --- naming ---------------------------------------------------------------

describe('backup file names', () => {
  test('UTC to the second, fixed width', () => {
    expect(backupFileName(new Date('2026-10-15T02:30:07.987Z'))).toBe('agentoo-20261015T023007Z.dump')
  })

  test('parse round-trips a name it wrote', () => {
    const at = parseBackupFileName('agentoo-20261015T023007Z.dump')
    expect(at?.toISOString()).toBe('2026-10-15T02:30:07.000Z')
  })

  test('anything else is not a backup', () => {
    for (const name of [
      'agentoo-20261015T023007Z.dump.partial',
      'agentoo-20261340T023007Z.dump', // month 13
      'agentoo-20261015T026107Z.dump', // minute 61
      'agentoo-latest.dump',
      'agentoo-20261015T023007Z.sql',
      'manual-20261015T023007Z.dump',
      'notes.txt',
    ]) {
      expect(parseBackupFileName(name)).toBeUndefined()
    }
  })
})

// --- retention ------------------------------------------------------------

describe('retention', () => {
  const KEEP = 14
  /** N+3 backups, one a day, newest first. */
  const backupNames = Array.from({ length: KEEP + 3 }, (_, i) =>
    backupFileName(new Date(Date.UTC(2026, 9, 20 - i, 2, 30, 0))),
  )
  /** Just after the newest of them. Retention reads names against a clock, so
   * these tests pass their own rather than depend on the date they run on. */
  const NOW = new Date(Date.UTC(2026, 9, 20, 3, 0, 0))
  const NOT_BACKUPS = [
    'notes.txt',
    'agentoo-manual.dump',
    'restore.sql',
    // Partials are never backups, however old: one is a dump still running.
    'agentoo-20200101T000000Z.dump.partial',
  ]

  async function seed() {
    // Written newest-first with mtimes running the *other* way, so an
    // implementation that sorted by mtime instead of by name would keep the
    // wrong ones.
    for (const [i, name] of backupNames.entries()) {
      const path = join(dir, name)
      await writeFile(path, `dump ${i}`)
      const mtime = new Date(Date.UTC(2020, 0, 1 + i))
      await utimes(path, mtime, mtime)
    }
    for (const name of NOT_BACKUPS) await writeFile(join(dir, name), 'not a backup')
    // A directory and a symlink that both look like backups by name.
    await mkdir(join(dir, 'agentoo-20100101T000000Z.dump'))
    await symlink('/etc/hostname', join(dir, 'agentoo-20100102T000000Z.dump'))
  }

  test(`given N+3 backups it keeps the newest N and deletes the 3 oldest`, async () => {
    await seed()
    const result = await applyRetention(dir, KEEP, undefined, NOW)
    expect(result.kept).toEqual(backupNames.slice(0, KEEP))
    expect(result.deleted.sort()).toEqual(backupNames.slice(KEEP).sort())
    expect(result.failed).toEqual([])
    const left = await readdir(dir)
    for (const name of backupNames.slice(0, KEEP)) expect(left).toContain(name)
    for (const name of backupNames.slice(KEEP)) expect(left).not.toContain(name)
  })

  test('non-backup files, *.partial, directories and symlinks are never touched', async () => {
    await seed()
    await applyRetention(dir, KEEP, undefined, NOW)
    const left = await readdir(dir)
    for (const name of NOT_BACKUPS) expect(left).toContain(name)
    expect(left).toContain('agentoo-20100101T000000Z.dump')
    expect(left).toContain('agentoo-20100102T000000Z.dump')
    expect(await readFile('/etc/hostname', 'utf8')).toBeTruthy()
  })

  test('listBackups ignores the same things, and lists newest first', async () => {
    await seed()
    expect((await listBackups(dir)).map((b) => b.name)).toEqual(backupNames)
  })

  test('fewer than N backups: nothing is deleted', async () => {
    await seed()
    const result = await applyRetention(dir, 100, undefined, NOW)
    expect(result.deleted).toEqual([])
    expect(result.kept).toHaveLength(backupNames.length)
  })

  test('the backup a run just wrote survives even if a future-dated file sorts above it', async () => {
    const future = backupFileName(new Date(Date.UTC(2099, 0, 1)))
    const justWritten = backupFileName(new Date(Date.UTC(2026, 9, 15, 2, 30)))
    await writeFile(join(dir, future), 'clock was ahead once')
    await writeFile(join(dir, justWritten), 'new')
    const result = await applyRetention(dir, 1, justWritten, new Date(Date.UTC(2026, 9, 15, 2, 31)))
    expect(result.deleted).toEqual([])
    expect((await readdir(dir)).sort()).toEqual([justWritten, future].sort())
  })

  test('a file named in the future neither takes a place among the newest N nor is deleted', async () => {
    await seed()
    // A year past the newest real backup.
    const future = backupFileName(new Date(Date.UTC(2027, 9, 20, 2, 30, 0)))
    await writeFile(join(dir, future), 'taken while the clock was a year ahead')
    const result = await applyRetention(dir, KEEP, undefined, NOW)
    // Still the 14 newest real backups: the future file did not push one out.
    expect(result.kept).toEqual(backupNames.slice(0, KEEP))
    expect(result.deleted.sort()).toEqual(backupNames.slice(KEEP).sort())
    expect(result.future).toEqual([future])
    expect(await readFile(join(dir, future), 'utf8')).toBe('taken while the clock was a year ahead')
  })

  test('with keep 1, the dump just taken is the one kept, whatever is named in the future', async () => {
    const now = new Date(Date.UTC(2026, 9, 15, 2, 30, 0))
    const justWritten = backupFileName(now)
    const older = backupFileName(new Date(Date.UTC(2026, 9, 14, 2, 30, 0)))
    const future = backupFileName(new Date(Date.UTC(2027, 9, 15, 2, 30, 0)))
    for (const name of [justWritten, older, future]) await writeFile(join(dir, name), name)
    const result = await applyRetention(dir, 1, justWritten, now)
    expect(result.kept).toEqual([justWritten])
    expect(result.deleted).toEqual([older])
    expect(result.future).toEqual([future])
    expect((await readdir(dir)).sort()).toEqual([justWritten, future].sort())
  })

  test('within the skew tolerance a name a little ahead is an ordinary backup', async () => {
    const now = new Date(Date.UTC(2026, 9, 15, 2, 30, 0))
    const backups = [
      new Date(now.getTime() + CLOCK_SKEW_TOLERANCE_MS + 1000), // future
      new Date(now.getTime() + CLOCK_SKEW_TOLERANCE_MS), // just within
      new Date(now.getTime() - 60_000),
    ].map((at) => ({ name: backupFileName(at), path: '', takenAt: at, bytes: 1 }))
    const { current, future } = splitByClock(backups, now)
    expect(future.map((b) => b.takenAt)).toEqual([backups[0]?.takenAt])
    expect(current.map((b) => b.takenAt)).toEqual([backups[1]?.takenAt, backups[2]?.takenAt])
  })

  test('refuses to keep fewer than one', async () => {
    await expect(applyRetention(dir, 0)).rejects.toThrow('at least one')
  })

  test('a missing directory has no backups', async () => {
    expect(await listBackups(join(dir, 'nope'))).toEqual([])
  })
})

describe('partials a crashed run left behind', () => {
  test('every partial of ours goes, however recent; nothing else is touched', async () => {
    const old = 'agentoo-20260101T000000Z.dump.partial'
    // Seconds old: under the lock, no running dump can own it either.
    const fresh = backupFileName(new Date()) + '.partial'
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const untouched = [
      'something-else.partial',
      // Other databases' or other tools' dumps, and look-alikes of ours.
      'otherdb-20260101T000000Z.dump.partial',
      'agentoo_staging-20260101T000000Z.dump.partial',
      'agentoo-latest.dump.partial',
      'agentoo-20260101T000000Z.dump.partial.keep',
      'agentoo-20261340T000000Z.dump.partial', // month 13: not a name we write
      // A finished backup.
      'agentoo-20260103T000000Z.dump',
    ]
    for (const name of [old, fresh, ...untouched]) await writeFile(join(dir, name), 'x')
    await utimes(join(dir, old), longAgo, longAgo)

    // Named exactly like ours, but a symlink (to a file outside) and a directory.
    const outside = join(dir, '..', `outside-${counter}`)
    await writeFile(outside, 'not in BACKUPS_DIR')
    const link = 'agentoo-20260104T000000Z.dump.partial'
    await symlink(outside, join(dir, link))
    const subdir = 'agentoo-20260105T000000Z.dump.partial'
    await mkdir(join(dir, subdir))
    await writeFile(join(dir, subdir, 'inside'), 'x')

    const result = await removeOrphanedPartials(dir)
    expect(result.removed.sort()).toEqual([old, fresh].sort())
    expect(result.failed).toEqual([])
    expect((await readdir(dir)).sort()).toEqual([...untouched, link, subdir].sort())
    expect(await readFile(outside, 'utf8')).toBe('not in BACKUPS_DIR')
    expect(await readFile(join(dir, link), 'utf8')).toBe('not in BACKUPS_DIR')
    expect(await readdir(join(dir, subdir))).toEqual(['inside'])
  })

  test('a missing directory has none', async () => {
    expect(await removeOrphanedPartials(join(dir, 'nope'))).toEqual({ removed: [], failed: [] })
  })
})

// --- free space ---------------------------------------------------------------

describe('free space before a dump', () => {
  const GiB = 1024 ** 3
  const estimate = { bytes: 1 * GiB, source: 'the size of agentoo-20261014T023000Z.dump' }
  /** A statfs answering for a filesystem of `total` bytes with `free` available. */
  const fakeStatfs =
    (total: number, free: number, unit = 4096): StatFs =>
    async () => ({ bsize: unit, frsize: unit, blocks: total / unit, bavail: free / unit })

  test('the reserve is 10% of the filesystem, but never under 2 GiB', () => {
    expect(MIN_FREE_BYTES).toBe(2 * GiB)
    expect(reservedBytes(100 * GiB)).toBe(10 * GiB)
    expect(reservedBytes(10 * GiB)).toBe(2 * GiB)
    expect(reservedBytes(20 * GiB)).toBe(2 * GiB)
  })

  test('a dump that would leave less than 10% of a large filesystem is refused, to the byte', () => {
    const total = 100 * GiB
    const fits = { totalBytes: total, freeBytes: 10 * GiB + estimate.bytes }
    expect(insufficientSpaceMessage('/b', fits, estimate)).toBeUndefined()
    const short = { totalBytes: total, freeBytes: 10 * GiB + estimate.bytes - 1 }
    const message = insufficientSpaceMessage('/b', short, estimate)
    expect(message).toContain('not enough free space')
    expect(message).toContain('/b')
    expect(message).toContain('the size of agentoo-20261014T023000Z.dump')
    expect(message).toContain('on top of the 10.0 GiB that must stay free')
    expect(message).toContain('Free up at least 1 B there')
  })

  test('on a small filesystem the 2 GiB floor applies instead', () => {
    const total = 8 * GiB // 10% would be 0.8 GiB
    expect(
      insufficientSpaceMessage('/b', { totalBytes: total, freeBytes: 2 * GiB + estimate.bytes }, estimate),
    ).toBeUndefined()
    expect(
      insufficientSpaceMessage('/b', { totalBytes: total, freeBytes: 3 * GiB - 1 }, estimate),
    ).toContain('on top of the 2.0 GiB that must stay free')
  })

  test('ensureFreeSpace refuses with an insufficient-space BackupError, from an injected statfs', async () => {
    const error = await ensureFreeSpace(dir, estimate, fakeStatfs(100 * GiB, 5 * GiB)).catch((e) => e)
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).kind).toBe('insufficient-space')
    expect((error as BackupError).message).toContain('5.0 GiB free of 100.0 GiB')
    expect(await readdir(dir)).toEqual([])

    expect(await ensureFreeSpace(dir, estimate, fakeStatfs(100 * GiB, 50 * GiB))).toEqual({
      totalBytes: 100 * GiB,
      freeBytes: 50 * GiB,
    })
  })

  test('sizes are counted in frsize units where statfs gives one, else bsize', async () => {
    const statfs: StatFs = async () => ({ bsize: 1024 * 1024, frsize: 4096, blocks: 1000, bavail: 10 })
    expect(await readFsSpace(dir, statfs)).toEqual({ totalBytes: 4096 * 1000, freeBytes: 4096 * 10 })
    const noFrsize: StatFs = async () => ({ bsize: 4096, blocks: 1000, bavail: 10 })
    expect(await readFsSpace(dir, noFrsize)).toEqual({ totalBytes: 4096 * 1000, freeBytes: 4096 * 10 })
  })

  test("the default is this runtime's own fs.statfs, and it reads the real filesystem", async () => {
    const space = await readFsSpace(dir)
    expect(space.totalBytes).toBeGreaterThan(0)
    expect(space.freeBytes).toBeGreaterThan(0)
    expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes)
  })
})

describe('the backups directory', () => {
  test('is created 0700', async () => {
    const target = join(dir, 'a', 'backups')
    await ensureBackupsDir(target)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
  })

  test('an existing, wider one is narrowed to 0700', async () => {
    const target = join(dir, 'wide')
    await mkdir(target, { mode: 0o755 })
    await chmod(target, 0o755)
    await ensureBackupsDir(target)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
  })

  test('a relative path is refused rather than resolved against the cwd', async () => {
    await expect(ensureBackupsDir('backups')).rejects.toThrow('absolute')
  })
})

// --- pg_dump's environment ------------------------------------------------

describe('pg_dump connection environment', () => {
  test('DATABASE_URL becomes the five PG* variables, decoded', () => {
    expect(pgEnvFromDatabaseUrl(URL_WITH_PASSWORD)).toEqual({
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
      PGUSER: 'agentoo',
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'agentoo',
    })
  })

  test('IPv6 hosts lose their brackets; sslmode and a socket ?host= carry over', () => {
    expect(pgEnvFromDatabaseUrl('postgres://u:p@[::1]:5433/db?sslmode=require')).toMatchObject({
      PGHOST: '::1',
      PGPORT: '5433',
      PGSSLMODE: 'require',
    })
    expect(pgEnvFromDatabaseUrl('postgres:///db?host=/var/run/postgresql').PGHOST).toBe(
      '/var/run/postgresql',
    )
  })

  test("no host in the URL means localhost over TCP, as for the app's own driver, never libpq's default socket", () => {
    expect(pgEnvFromDatabaseUrl('postgresql:///db')).toEqual({ PGHOST: 'localhost', PGDATABASE: 'db' })
  })

  test('a bad URL is refused without quoting it', () => {
    expect(() => pgEnvFromDatabaseUrl(`not a url ${PASSWORD}`)).toThrow('not a valid URL')
    try {
      pgEnvFromDatabaseUrl(`mysql://u:${PASSWORD}@h/db`)
    } catch (error) {
      expect((error as Error).message).not.toContain(PASSWORD)
    }
  })

  test("the child env drops every app credential and adds only the PG* it needs", () => {
    const env = backupChildEnv(URL_WITH_PASSWORD, {
      PATH: '/usr/bin',
      HOME: '/home/agentoo',
      DATABASE_URL: URL_WITH_PASSWORD,
      POSTGRES_PASSWORD: PASSWORD,
      REDIS_URL: 'redis://:secret@127.0.0.1:6379',
      REDIS_PASSWORD: 'secret',
      PGSERVICE: 'elsewhere',
      PGOPTIONS: '-c search_path=evil',
      PGHOST: '10.0.0.9',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/agentoo')
    for (const key of ['DATABASE_URL', 'POSTGRES_PASSWORD', 'REDIS_URL', 'REDIS_PASSWORD']) {
      expect(env[key]).toBeUndefined()
    }
    expect(Object.keys(env).filter((k) => k.startsWith('PG')).sort()).toEqual([
      'PGDATABASE',
      'PGHOST',
      'PGPASSWORD',
      'PGPORT',
      'PGUSER',
    ])
    expect(env.PGHOST).toBe('127.0.0.1')
  })
})

// --- versions ---------------------------------------------------------------

describe('pg_dump versions', () => {
  test('reads the major version off --version output', () => {
    expect(parsePgDumpVersion('pg_dump (PostgreSQL) 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)\n')).toEqual({
      major: 18,
      text: 'pg_dump (PostgreSQL) 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)',
    })
    expect(parsePgDumpVersion('something else')).toBeUndefined()
  })

  test('older than the server is a clear message; equal or newer is fine', () => {
    const message = pgDumpTooOldMessage(17, 180006, '18.6')
    expect(message).toContain('pg_dump 17 is older than the PostgreSQL server (18.6)')
    expect(message).toContain('postgresql-client-18')
    expect(pgDumpTooOldMessage(18, 180006)).toBeUndefined()
    expect(pgDumpTooOldMessage(19, 180006)).toBeUndefined()
  })

  test("pg_dump's own mismatch error is recognised and reworded", () => {
    const stderr =
      'pg_dump: error: aborting because of server version mismatch\n' +
      'pg_dump: detail: server version: 18.1; pg_dump version: 17.6\n'
    const message = versionMismatchFromStderr(stderr)
    expect(message).toContain('pg_dump 17.6 is older than the PostgreSQL server (18.1)')
    expect(message).toContain('postgresql-client-18')
    expect(versionMismatchFromStderr('pg_dump: error: connection refused')).toBeUndefined()
  })

  test('a missing binary is a BackupError, not a crash', async () => {
    const error = await readPgDumpVersion('/nonexistent/pg_dump', childEnv()).catch((e) => e)
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).kind).toBe('missing-binary')
    expect((error as BackupError).message).toContain('postgresql-client')
  })
})

// --- the dump itself ------------------------------------------------------

const at = new Date('2026-10-15T02:30:00Z')
const NAME = 'agentoo-20261015T023000Z.dump'

describe('dumpDatabase', () => {
  test('success: renamed from .partial to the final name, 0600, argv without the password', async () => {
    const capture = join(dir, '..', `capture-${counter}`)
    await mkdir(capture, { recursive: true })
    const bin = await fakePgDump(
      `ok-${counter}`,
      `printf '%s\\n' "$@" > '${capture}/argv'
tr '\\0' '\\n' < /proc/$$/cmdline > '${capture}/cmdline'
env > '${capture}/env'
${FIND_OUT}
ls -l "$out" > '${capture}/partial-mode'
printf 'PGDMP fake archive' > "$out"`,
    )
    const result = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 10_000 })
    expect(result).toEqual({ name: NAME, path: join(dir, NAME), bytes: 18 })
    expect(await readdir(dir)).toEqual([NAME])
    expect((await stat(join(dir, NAME))).mode & 0o777).toBe(0o600)

    const argv = await readFile(join(capture, 'argv'), 'utf8')
    const cmdline = await readFile(join(capture, 'cmdline'), 'utf8')
    expect(argv.split('\n').filter(Boolean)).toEqual([
      '--format=custom',
      '--no-password',
      `--file=${join(dir, NAME)}.partial`,
    ])
    for (const text of [argv, cmdline]) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(encodeURIComponent(PASSWORD))
      expect(text).not.toContain('postgres')
    }
    // The partial already existed, 0600, before pg_dump opened it.
    expect(await readFile(join(capture, 'partial-mode'), 'utf8')).toStartWith('-rw-------')
    const env = await readFile(join(capture, 'env'), 'utf8')
    expect(env).toContain(`PGPASSWORD=${PASSWORD}\n`)
    expect(env).not.toContain('DATABASE_URL')
  })

  test('pg_dump failing midway leaves no partial and no backup behind', async () => {
    const bin = await fakePgDump(
      `fail-${counter}`,
      `${FIND_OUT}
printf 'half an archive' > "$out"
echo 'pg_dump: error: query failed: connection lost' >&2
exit 1`,
    )
    const error = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 10_000 }).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).kind).toBe('pg_dump-failed')
    expect((error as BackupError).message).toContain('connection lost')
    expect(await readdir(dir)).toEqual([])
  })

  test("pg_dump's server-version-mismatch error comes back as a clear message", async () => {
    const bin = await fakePgDump(
      `mismatch-${counter}`,
      `echo 'pg_dump: error: aborting because of server version mismatch' >&2
echo 'pg_dump: detail: server version: 18.1; pg_dump version: 16.4' >&2
exit 1`,
    )
    const error = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 10_000 }).catch(
      (e) => e,
    )
    expect((error as BackupError).kind).toBe('version-mismatch')
    expect((error as BackupError).message).toContain('pg_dump 16.4 is older than the PostgreSQL server (18.1)')
    expect(await readdir(dir)).toEqual([])
  })

  test('a missing pg_dump leaves nothing behind', async () => {
    const error = await dumpDatabase({
      bin: '/nonexistent/pg_dump',
      env: childEnv(),
      dir,
      at,
      timeoutMs: 10_000,
    }).catch((e) => e)
    expect((error as BackupError).kind).toBe('missing-binary')
    expect(await readdir(dir)).toEqual([])
  })

  test('a hung pg_dump is stopped at the timeout and leaves nothing behind', async () => {
    const bin = await fakePgDump(`hang-${counter}`, 'exec sleep 30')
    const started = Date.now()
    const error = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 300 }).catch(
      (e) => e,
    )
    expect((error as BackupError).kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await readdir(dir)).toEqual([])
  })

  test('exit 0 with an empty file is a failure, not a backup', async () => {
    const bin = await fakePgDump(`empty-${counter}`, 'exit 0')
    const error = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 10_000 }).catch(
      (e) => e,
    )
    expect((error as BackupError).message).toContain('wrote nothing')
    expect(await readdir(dir)).toEqual([])
  })

  test('a backup already named for this second is never overwritten', async () => {
    await writeFile(join(dir, NAME), 'earlier backup')
    const bin = await fakePgDump(`ok2-${counter}`, `${FIND_OUT}\nprintf 'PGDMP' > "$out"`)
    const result = await dumpDatabase({ bin, env: childEnv(), dir, at, timeoutMs: 10_000 })
    expect(result.name).toBe('agentoo-20261015T023001Z.dump')
    expect(await readFile(join(dir, NAME), 'utf8')).toBe('earlier backup')
  })
})
