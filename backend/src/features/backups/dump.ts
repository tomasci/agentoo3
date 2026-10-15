// Postgres backups, the half that only touches the filesystem and a pg_dump
// child: file naming, the write-to-partial-then-rename dump, retention, the
// clean-up of partials a crash left, the free-space check, and the
// environment pg_dump runs with. No database client, no env.ts and no
// logger on purpose: service.ts wraps all of this in the advisory lock, the
// server-version check and the logging, while tests/db-backup.test.ts drives
// these functions directly inside the shared test process, where @/env and
// @/db/client are routinely replaced by other files' mocks.

import { chmod, lstat, mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withoutAppCredentials } from '@/lib/child-env'
import { readBounded } from '@/lib/spawn'

/** `agentoo-20261015T023000Z.dump`: the UTC time the dump started, to the
 * second, fixed width, so a plain name sort is a time sort and an operator
 * can read a file's age straight off `ls`. */
const BACKUP_NAME = /^agentoo-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/

/** What a dump is written as until pg_dump has exited 0. Never a backup:
 * listBackups and retention skip it, because the name no longer ends in
 * `.dump`. */
export const PARTIAL_SUFFIX = '.partial'

export type BackupErrorKind =
  | 'missing-binary'
  | 'version-mismatch'
  | 'pg_dump-failed'
  | 'timeout'
  | 'insufficient-space'

/** A failure with a message meant for the operator's log as it stands. */
export class BackupError extends Error {
  readonly kind: BackupErrorKind
  constructor(kind: BackupErrorKind, message: string) {
    super(message)
    this.name = 'BackupError'
    this.kind = kind
  }
}

export function backupFileName(at: Date): string {
  // 2026-10-15T02:30:00.123Z -> 20261015T023000
  const compact = at.toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `agentoo-${compact}Z.dump`
}

/** The time a backup's name records, or undefined for anything that is not a
 * backup file (including a `.partial`). */
export function parseBackupFileName(name: string): Date | undefined {
  const match = BACKUP_NAME.exec(name)
  if (!match) return undefined
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Date.UTC rolls a 13th month or a 61st second over rather than refusing
  // it; a name that does not survive the round trip was not written by us.
  if (Number.isNaN(at.getTime()) || backupFileName(at) !== name) return undefined
  return at
}

export interface BackupFile {
  name: string
  path: string
  takenAt: Date
  bytes: number
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Every backup in `dir`, newest first. Only regular files whose name parses:
 * a `.partial`, a symlink, a directory or anything an operator dropped in by
 * hand is not a backup and is never counted or deleted. A missing `dir` is an
 * empty list. */
export async function listBackups(dir: string): Promise<BackupFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const backups: BackupFile[] = []
  for (const name of names) {
    const takenAt = parseBackupFileName(name)
    if (!takenAt) continue
    const path = join(dir, name)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile()) continue
    backups.push({ name, path, takenAt, bytes: info.size })
  }
  // Fixed-width UTC names: descending name order is newest first.
  return backups.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

/** How far past this host's clock a backup's name may be and still count as
 * an ordinary backup: room for two clocks a little apart, or NTP stepping
 * this one back by a few seconds. Anything further ahead was named by a clock
 * that was wrong at the time (a boot before NTP had synced), or this one is
 * wrong now. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/**
 * `backups` (newest first, as listBackups returns them) split at `now`:
 * `current` are named no later than the skew tolerance past it, `future` are
 * named further ahead than that. A future-named file says nothing about how
 * recent the newest real backup is, so it is never what a run's freshness
 * check looks at, and retention neither counts nor deletes it.
 */
export function splitByClock(
  backups: BackupFile[],
  now: Date,
): { current: BackupFile[]; future: BackupFile[] } {
  const limit = now.getTime() + CLOCK_SKEW_TOLERANCE_MS
  return {
    current: backups.filter((b) => b.takenAt.getTime() <= limit),
    future: backups.filter((b) => b.takenAt.getTime() > limit),
  }
}

export interface RetentionResult {
  kept: string[]
  deleted: string[]
  failed: { name: string; error: string }[]
  /** Named in the future (see splitByClock): left alone, and not counted. */
  future: string[]
}

/**
 * Deletes every backup in `dir` but the newest `keep`. Only ever called after
 * a new backup has been written, so a run of failed dumps never eats into the
 * backups already on disk.
 *
 * Newest by the time in the name, as of `now`. A file named in the future
 * (the clock was once ahead) is neither counted nor deleted: counted, it
 * would sit at the top of the list until the clock caught up with it, taking
 * one of the `keep` places from a real backup every day, and it is still a
 * real dump of whenever it was taken, so it is not this code's to delete. It
 * stays until the clock passes its name, or an operator removes it.
 *
 * `protect` is the backup that run just wrote, kept whatever its place: the
 * dump just taken is never the one retention deletes, even when a file
 * within the skew tolerance sorts above it and `keep` is 1.
 */
export async function applyRetention(
  dir: string,
  keep: number,
  protect?: string,
  now: Date = new Date(),
): Promise<RetentionResult> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`retention must keep at least one backup (got ${keep})`)
  }
  const { current: backups, future } = splitByClock(await listBackups(dir), now)
  const result: RetentionResult = {
    kept: backups.slice(0, keep).map((b) => b.name),
    deleted: [],
    failed: [],
    future: future.map((b) => b.name),
  }
  for (const backup of backups.slice(keep)) {
    if (backup.name === protect) {
      result.kept.push(backup.name)
      continue
    }
    try {
      await rm(backup.path, { force: true })
      result.deleted.push(backup.name)
    } catch (error) {
      result.failed.push({ name: backup.name, error: errorMessage(error) })
    }
  }
  return result
}

/**
 * Deletes every `.partial` this job's own dumps leave in `dir`: only ever
 * called by a run holding the backup lock, and while it is held no other dump
 * of this database can be running, so every one of them was left by a dump
 * that died with its process (the worker killed mid-dump, the box losing
 * power), which nothing else will ever clean up. However recent: a crash
 * loop would otherwise leave one per try, each up to a whole dump in size.
 * (Were the lock lost mid-dump with the connection holding it, the worst
 * this does is make that dump fail when it reopens its partial to fsync it;
 * a backup's name never ends up on a half-written file.)
 *
 * Only regular files named `<one of our backup names>.partial`: anything else
 * in `dir`, a symlink or directory by that name included, is not ours and is
 * never touched (lstat, so a symlink is never followed). A file that cannot
 * be deleted is reported, not thrown: it must not stop the backup itself.
 */
export async function removeOrphanedPartials(
  dir: string,
): Promise<{ removed: string[]; failed: { name: string; error: string }[] }> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { removed: [], failed: [] }
    throw error
  }
  const removed: string[] = []
  const failed: { name: string; error: string }[] = []
  for (const name of names.sort()) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue
    if (!parseBackupFileName(name.slice(0, -PARTIAL_SUFFIX.length))) continue
    const path = join(dir, name)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile()) continue
    try {
      await rm(path, { force: true })
      removed.push(name)
    } catch (error) {
      failed.push({ name, error: errorMessage(error) })
    }
  }
  return { removed, failed }
}

// --- free space ---------------------------------------------------------------

/**
 * What a dump has to leave free on BACKUPS_DIR's filesystem, whichever is
 * larger: this fraction of the filesystem, or this many bytes. By default
 * BACKUPS_DIR is on the same disk as Postgres's data directory and WAL, and a
 * Postgres that cannot write WAL stops (PANIC), so a backup must never be
 * what fills it, nor leave it so full that the next day's writes do. Fixed
 * rather than settings: the point is a floor no configuration mistake can
 * take away. 2 GiB covers a small disk, where 10% would be next to nothing.
 */
export const MIN_FREE_FRACTION = 0.1
export const MIN_FREE_BYTES = 2 * 1024 ** 3

/** The fields of fs.statfs this reads: sizes are in `frsize` units where the
 * platform reports one (as Linux and Bun do), else in `bsize` ones. */
export interface StatFsResult {
  bsize: number
  frsize?: number
  blocks: number
  bavail: number
}
export type StatFs = (path: string) => Promise<StatFsResult>

export interface FsSpace {
  totalBytes: number
  /** Free to an unprivileged process: bavail, not bfree, since the worker
   * cannot write into the blocks reserved for root. */
  freeBytes: number
}

/** How big the dump about to be taken is expected to be, and how that was
 * worked out, for the log. */
export interface DumpEstimate {
  bytes: number
  source: string
}

export async function readFsSpace(dir: string, statfsImpl: StatFs = statfs): Promise<FsSpace> {
  const info = await statfsImpl(dir)
  const unit = info.frsize || info.bsize
  return { totalBytes: info.blocks * unit, freeBytes: info.bavail * unit }
}

/** The free space a dump has to leave behind on a filesystem of `totalBytes`. */
export const reservedBytes = (totalBytes: number): number =>
  Math.max(Math.ceil(totalBytes * MIN_FREE_FRACTION), MIN_FREE_BYTES)

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`
}

/** The operator-facing refusal when a dump of `estimate` would leave less
 * than reservedBytes free, or undefined when there is room. */
export function insufficientSpaceMessage(
  dir: string,
  space: FsSpace,
  estimate: DumpEstimate,
): string | undefined {
  const reserve = reservedBytes(space.totalBytes)
  const shortBy = estimate.bytes + reserve - space.freeBytes
  if (shortBy <= 0) return undefined
  return (
    `not enough free space for a backup: the filesystem holding ${dir} has ` +
    `${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}, and the dump needs ` +
    `about ${formatBytes(estimate.bytes)} (${estimate.source}) on top of the ` +
    `${formatBytes(reserve)} that must stay free (${MIN_FREE_FRACTION * 100}% of the filesystem ` +
    `or ${formatBytes(MIN_FREE_BYTES)}, whichever is larger), so that a backup never fills the ` +
    `disk Postgres writes its data and WAL to. No dump was started. Free up at least ` +
    `${formatBytes(shortBy)} there, or point BACKUPS_DIR at another filesystem.`
  )
}

/** Throws an `insufficient-space` BackupError unless `dir`'s filesystem has
 * room for `estimate` and the reserve on top. */
export async function ensureFreeSpace(
  dir: string,
  estimate: DumpEstimate,
  statfsImpl: StatFs = statfs,
): Promise<FsSpace> {
  const space = await readFsSpace(dir, statfsImpl)
  const refusal = insufficientSpaceMessage(dir, space, estimate)
  if (refusal) throw new BackupError('insufficient-space', refusal)
  return space
}

/** Creates `dir` 0700 if it is missing, and narrows it to 0700 if it is not:
 * every file in it is a full copy of the database. */
export async function ensureBackupsDir(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new Error(`BACKUPS_DIR must be an absolute path (got "${dir}")`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await stat(dir)
  if (!info.isDirectory()) throw new Error(`BACKUPS_DIR ${dir} is not a directory`)
  if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700)
}

/**
 * The libpq variables pg_dump connects with, taken apart from DATABASE_URL:
 * PGHOST, and PGPORT, PGUSER, PGPASSWORD and PGDATABASE when the URL has
 * them, plus PGSSLMODE when it asks for one. Through the environment, never argv: anyone on the box
 * can read another process's argv with `ps`, but not its environment.
 *
 * Errors never quote the URL, since it carries the password.
 */
export function pgEnvFromDatabaseUrl(databaseUrl: string): Record<string, string> {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must be a postgres:// URL (got ${url.protocol}//...)`)
  }
  const pg: Record<string, string> = {}
  // An IPv6 literal comes back bracketed; a socket directory can only be
  // given as ?host=, since a path cannot sit in the authority. With neither,
  // localhost: what the app's own driver (postgres.js) connects to for a URL
  // with no host, over TCP. Left unset, libpq would pick the default unix
  // socket instead, which is not necessarily the server the app uses, and
  // is the one way in that does not need the password (see
  // scripts/60-install-postgres.sh's "unix-socket auth").
  const host = url.hostname
    ? url.hostname.replace(/^\[(.*)\]$/, '$1')
    : (url.searchParams.get('host') ?? 'localhost')
  pg.PGHOST = host
  const port = url.port || url.searchParams.get('port') || ''
  if (port) pg.PGPORT = port
  if (url.username) pg.PGUSER = decodeURIComponent(url.username)
  if (url.password) pg.PGPASSWORD = decodeURIComponent(url.password)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (database) pg.PGDATABASE = database
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) pg.PGSSLMODE = sslmode
  return pg
}

/**
 * pg_dump's whole environment: this process's, minus every app credential
 * (lib/child-env.ts), plus exactly the PG* variables above. Stripping first
 * matters even though pg_dump is ours: a stray PGSERVICE or PGOPTIONS in the
 * worker's environment would otherwise change where, or how, it connects.
 */
export function backupChildEnv(
  databaseUrl: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return { ...withoutAppCredentials(source), ...pgEnvFromDatabaseUrl(databaseUrl) }
}

/** `pg_dump (PostgreSQL) 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)` -> 18. */
export function parsePgDumpVersion(output: string): { major: number; text: string } | undefined {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(output)
  if (!match) return undefined
  return { major: Number(match[1]), text: output.trim().split('\n')[0] ?? '' }
}

/** server_version_num (180006) -> 18. */
export const serverMajorVersion = (serverVersionNum: number): number =>
  Math.floor(serverVersionNum / 10_000)

function tooOldMessage(pgDumpVersion: string, serverVersion: string): string {
  const serverMajor = Number.parseInt(serverVersion, 10)
  const client = Number.isFinite(serverMajor)
    ? `postgresql-client-${serverMajor}`
    : 'postgresql-client'
  return (
    `pg_dump ${pgDumpVersion} is older than the PostgreSQL server (${serverVersion}), and pg_dump ` +
    'refuses to dump a server newer than itself (server version mismatch). Install ' +
    `${client} so the pg_dump on the worker's PATH is at least the server's major version.`
  )
}

/** The operator-facing message when pg_dump is older than the server, or
 * undefined when it is not. */
export function pgDumpTooOldMessage(
  pgDumpMajor: number,
  serverVersionNum: number,
  serverVersion = String(serverMajorVersion(serverVersionNum)),
): string | undefined {
  if (pgDumpMajor >= serverMajorVersion(serverVersionNum)) return undefined
  return tooOldMessage(String(pgDumpMajor), serverVersion)
}

/** The same message, recognised in pg_dump's own stderr — the fallback for
 * when the preflight check could not tell (a wrapper reporting one version
 * and running another). */
export function versionMismatchFromStderr(stderr: string): string | undefined {
  if (!/server version mismatch/i.test(stderr)) return undefined
  const match = /server version:\s*([^;\s]+);\s*pg_dump version:\s*(\S+)/i.exec(stderr)
  return tooOldMessage(match?.[2] ?? '(unknown version)', match?.[1] ?? 'unknown version')
}

/** The last part of a child's stderr, for a log line. */
const tail = (text: string, max = 1500): string => {
  const trimmed = text.trim()
  return trimmed.length > max ? `...${trimmed.slice(-max)}` : trimmed || '(no output)'
}

function spawnPgDump(bin: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  try {
    return Bun.spawn([bin, ...args], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
  } catch (error) {
    // ENOENT for a path, "Executable not found in $PATH" for a bare name.
    throw new BackupError(
      'missing-binary',
      `could not run pg_dump (${bin}): ${errorMessage(error)}. Install the PostgreSQL client ` +
        'tools (the postgresql-client package) on this host.',
    )
  }
}

/** Runs `<bin> --version`. Also the cheap way to find out the binary is
 * missing before anything is written. */
export async function readPgDumpVersion(
  bin: string,
  env: Record<string, string>,
): Promise<{ major: number; text: string }> {
  const proc = spawnPgDump(bin, ['--version'], env, 30_000)
  const [stdout, stderr, code] = await Promise.all([
    readBounded(proc.stdout, proc.exited),
    readBounded(proc.stderr, proc.exited),
    proc.exited,
  ])
  const parsed = parsePgDumpVersion(stdout)
  if (code !== 0 || !parsed) {
    throw new BackupError(
      'pg_dump-failed',
      `\`${bin} --version\` did not report a PostgreSQL version (exit ${code}): ${tail(stderr || stdout)}`,
    )
  }
  return parsed
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

export interface DumpResult {
  name: string
  path: string
  bytes: number
}

/**
 * One `pg_dump --format=custom` of the database `env` points at, into `dir`.
 *
 * Written to `<name>.partial` and renamed only once pg_dump has exited 0, so a
 * file with a backup's name is always a complete dump; on any failure the
 * partial is deleted and this throws. The partial is created here, 0600 and
 * exclusively, before pg_dump opens it: left to pg_dump it would be created
 * under the process umask, readable by every account on the box for as long
 * as the dump runs.
 *
 * argv carries flags and the output path only. The connection, password
 * included, is in `env` (see backupChildEnv).
 */
export async function dumpDatabase(opts: {
  bin: string
  env: Record<string, string>
  dir: string
  at: Date
  timeoutMs: number
}): Promise<DumpResult> {
  // Under the caller's lock the only possible collision is two runs inside
  // one second (a manual run straight after a scheduled one); step forward a
  // second rather than overwrite a finished backup.
  let at = new Date(Math.floor(opts.at.getTime() / 1000) * 1000)
  let name = backupFileName(at)
  while (
    (await exists(join(opts.dir, name))) ||
    (await exists(join(opts.dir, name + PARTIAL_SUFFIX)))
  ) {
    at = new Date(at.getTime() + 1000)
    name = backupFileName(at)
  }
  const path = join(opts.dir, name)
  const partial = path + PARTIAL_SUFFIX

  await (await open(partial, 'wx', 0o600)).close()
  try {
    const proc = spawnPgDump(
      opts.bin,
      ['--format=custom', '--no-password', `--file=${partial}`],
      opts.env,
      opts.timeoutMs,
    )
    const [stdout, stderr, code] = await Promise.all([
      readBounded(proc.stdout, proc.exited),
      readBounded(proc.stderr, proc.exited),
      proc.exited,
    ])
    if (proc.signalCode) {
      throw new BackupError(
        'timeout',
        proc.killed
          ? `pg_dump did not finish within ${Math.round(opts.timeoutMs / 60_000)} minutes and was stopped`
          : `pg_dump was killed by ${proc.signalCode}`,
      )
    }
    if (code !== 0) {
      const mismatch = versionMismatchFromStderr(stderr)
      if (mismatch) throw new BackupError('version-mismatch', mismatch)
      throw new BackupError('pg_dump-failed', `pg_dump exited ${code}: ${tail(stderr || stdout)}`)
    }

    const handle = await open(partial, 'r+')
    let bytes: number
    try {
      // fsync before the rename, so a crash cannot leave a backup's name
      // pointing at data that never reached the disk.
      await handle.chmod(0o600)
      await handle.sync()
      bytes = (await handle.stat()).size
    } finally {
      await handle.close()
    }
    if (bytes === 0) throw new BackupError('pg_dump-failed', 'pg_dump exited 0 but wrote nothing')

    await rename(partial, path)
    // And the directory, so the rename itself is durable. Best effort: some
    // filesystems refuse fsync on a directory, and the dump is already whole.
    await open(opts.dir, 'r')
      .then(async (dirHandle) => {
        try {
          await dirHandle.sync()
        } finally {
          await dirHandle.close()
        }
      })
      .catch(() => {})
    return { name, path, bytes }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {})
    throw error
  }
}
