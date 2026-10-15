// Scheduled Postgres backups: one run, from whichever of its three callers
// started it: the worker's daily job (queue/db-backup.worker.ts), the
// worker's boot check, or `bun run backup` by hand (src/backup.ts). The
// operator's side of it (where the files live, retention, restoring) is the
// "Backups" section of the top-level README.md; dump.ts has the filesystem
// half.
//
// Every run holds one Postgres advisory lock for its whole length
// (withAdvisoryLock in db/client.ts), so two workers, a slow dump overlapping
// the next trigger, or a manual run during a scheduled one never write two
// dumps at once: the second waits, then re-checks whether the first already
// covered it. The lock lives in Postgres rather than in BullMQ because one of
// the callers (the manual CLI) never goes through the queue at all, and
// because BullMQ's own `concurrency: 1` is per worker process, not per box.
//
// runDbBackup never throws. Every failure is logged at error level, with what
// is still on disk, and returned, so nothing about a backup can take the
// worker down.

import { sql } from 'drizzle-orm'
import { db, withAdvisoryLock } from '@/db/client'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import {
  applyRetention,
  BackupError,
  type BackupErrorKind,
  type BackupFile,
  backupChildEnv,
  type DumpEstimate,
  dumpDatabase,
  ensureBackupsDir,
  ensureFreeSpace,
  errorMessage,
  formatBytes,
  listBackups,
  pgDumpTooOldMessage,
  readPgDumpVersion,
  removeOrphanedPartials,
  type StatFs,
  splitByClock,
} from './dump'

export const DB_BACKUP_LOCK_KEY = 'agentoo:db-backup'

/** How long one pg_dump may run before it is stopped. Generous: the point is
 * that a hung dump cannot hold the lock, and every later backup, forever. */
export const BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type DbBackupReason = 'scheduled' | 'boot' | 'manual'

/**
 * A run skips itself when the newest backup is younger than this — checked
 * under the lock, so a run that waited behind another sees what that one
 * wrote. A backup named further in the future than CLOCK_SKEW_TOLERANCE_MS
 * (dump.ts) never counts: its age would come out negative, younger than
 * either limit, and every run would skip until the clock caught up with it.
 *
 * - boot: 24h. The worker's start-up catch-up, for a box that was down (or
 *   only just installed) when the daily job was due.
 * - scheduled: 1h. The daily job right after a boot catch-up, or a stalled
 *   job BullMQ hands out a second time, would otherwise write a near-copy
 *   and push a whole day out of retention.
 * - manual: never; asked for by hand, so it always runs.
 */
export const SKIP_IF_NEWER_THAN_MS: Record<DbBackupReason, number> = {
  boot: 24 * HOUR_MS,
  scheduled: HOUR_MS,
  manual: 0,
}

export interface RunDbBackupOptions {
  reason: DbBackupReason
  /** Defaults to env.BACKUPS_DIR. */
  dir?: string
  /** Defaults to env.BACKUP_RETENTION_COUNT. */
  keep?: number
  /** The pg_dump to run; a bare name is looked up on PATH. */
  pgDump?: string
  now?: () => Date
  /** Reads BACKUPS_DIR's filesystem for the free-space check. Defaults to
   * fs.statfs. */
  statfs?: StatFs
}

export type DbBackupResult =
  | {
      status: 'created'
      path: string
      bytes: number
      durationMs: number
      deleted: string[]
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; kind: BackupErrorKind | 'other'; error: string }

/** A duration for the log: minutes, hours, or past two days, days. */
const formatAge = (ms: number): string => {
  if (ms < HOUR_MS) return `${Math.max(0, Math.round(ms / 60_000))}m`
  if (ms < 2 * DAY_MS) return `${(ms / HOUR_MS).toFixed(1)}h`
  return `${(ms / DAY_MS).toFixed(1)} days`
}

/** The warning for backups named in the future, naming each and how far. */
const futureBackupsWarning = (future: BackupFile[], now: Date): string =>
  `${future.map((b) => `${b.name} is named ${formatAge(b.takenAt.getTime() - now.getTime())}`).join(', ')} ` +
  `ahead of this host's clock (now ${now.toISOString()}): the clock was ahead when ` +
  `${future.length === 1 ? 'it was' : 'they were'} written, or is behind now. ` +
  `Not counted as a recent backup, nor by retention, which also never deletes ` +
  `${future.length === 1 ? 'it' : 'them'}; check the clock (timedatectl), and remove ` +
  `${future.length === 1 ? 'it' : 'them'} by hand once no longer wanted.`

async function serverVersion(): Promise<{ num: number; text: string }> {
  const rows = await db.execute<{ num: string; text: string }>(
    sql`select current_setting('server_version_num') as num, current_setting('server_version') as text`,
  )
  const row = rows[0]
  const num = Number(row?.num)
  if (!row || !Number.isFinite(num)) throw new Error('could not read the server version')
  return { num, text: row.text }
}

/** What the next dump will take: the size of the most recent one, or with
 * none on disk, of the database itself, which a compressed custom-format
 * dump never comes near. */
async function dumpEstimate(sample: BackupFile | undefined): Promise<DumpEstimate> {
  if (sample) return { bytes: sample.bytes, source: `the size of ${sample.name}` }
  const rows = await db.execute<{ bytes: string }>(
    sql`select pg_database_size(current_database())::text as bytes`,
  )
  const bytes = Number(rows[0]?.bytes)
  if (!Number.isFinite(bytes)) throw new Error('could not read the size of the database')
  return { bytes, source: 'the size of the database itself, there being no earlier backup' }
}

async function runLocked(
  opts: Required<Omit<RunDbBackupOptions, 'statfs'>> & Pick<RunDbBackupOptions, 'statfs'>,
): Promise<DbBackupResult> {
  const { reason, dir, keep, pgDump } = opts
  await ensureBackupsDir(dir)

  // Every run, before it decides whether to skip: with the lock held, each
  // partial of ours in `dir` is from a dump that died with its process.
  const partials = await removeOrphanedPartials(dir)
  if (partials.removed.length > 0) {
    logger.warn(
      `Database backup: removed ${partials.removed.length} unfinished dump(s) a crashed run ` +
        `left behind: ${partials.removed.join(', ')}`,
    )
  }
  for (const failure of partials.failed) {
    logger.warn(
      `Database backup: could not delete unfinished dump ${failure.name}: ${failure.error}`,
    )
  }

  const now = opts.now()
  const { current, future } = splitByClock(await listBackups(dir), now)
  if (future.length > 0) {
    logger.warn(`Database backup (${reason}): ${futureBackupsWarning(future, now)}`)
  }
  const newest = current[0]

  const skipIfNewerThanMs = SKIP_IF_NEWER_THAN_MS[reason]
  if (skipIfNewerThanMs > 0 && newest) {
    const age = now.getTime() - newest.takenAt.getTime()
    if (age < skipIfNewerThanMs) {
      const why = `newest backup ${newest.name} is only ${formatAge(age)} old`
      logger.info(`Database backup (${reason}) skipped: ${why}`)
      return { status: 'skipped', reason: why }
    }
  }

  const childEnv = backupChildEnv(env.DATABASE_URL)
  const pgDumpVersion = await readPgDumpVersion(pgDump, childEnv)
  const server = await serverVersion()
  const tooOld = pgDumpTooOldMessage(pgDumpVersion.major, server.num, server.text)
  if (tooOld) throw new BackupError('version-mismatch', tooOld)

  await ensureFreeSpace(dir, await dumpEstimate(newest ?? future[0]), opts.statfs)

  const started = opts.now()
  const dumped = await dumpDatabase({
    bin: pgDump,
    env: childEnv,
    dir,
    at: started,
    timeoutMs: BACKUP_TIMEOUT_MS,
  })
  const durationMs = opts.now().getTime() - started.getTime()

  // Only now, with a new backup safely on disk.
  let deleted: string[] = []
  try {
    const retention = await applyRetention(dir, keep, dumped.name, opts.now())
    deleted = retention.deleted
    for (const failure of retention.failed) {
      logger.warn(`Database backup: could not delete old backup ${failure.name}: ${failure.error}`)
    }
  } catch (error) {
    logger.warn(`Database backup: retention failed, nothing deleted: ${errorMessage(error)}`)
  }

  logger.info(
    `Database backup (${reason}) written: ${dumped.path} (${formatBytes(dumped.bytes)}, ` +
      `${(durationMs / 1000).toFixed(1)}s, ${pgDumpVersion.text}); keeping the newest ${keep}` +
      (deleted.length > 0 ? `, deleted ${deleted.join(', ')}` : ''),
  )
  return { status: 'created', path: dumped.path, bytes: dumped.bytes, durationMs, deleted }
}

/** What is on disk right now, for the failure log: the operator reading it
 * needs to know how exposed they are, not just that this run failed. */
async function newestBackupNote(dir: string, now: Date): Promise<string> {
  try {
    const { current, future } = splitByClock(await listBackups(dir), now)
    const [newest] = current
    const note = newest
      ? `The newest backup is ${newest.path} (${formatAge(now.getTime() - newest.takenAt.getTime())} old).`
      : `There is NO backup in ${dir}${future.length > 0 ? ' named for a time already past' : ' at all'}.`
    if (future.length === 0) return note
    return `${note} Not counted, being named in the future: ${future.map((b) => b.name).join(', ')}.`
  } catch (error) {
    return `Could not list ${dir}: ${errorMessage(error)}`
  }
}

export async function runDbBackup(options: RunDbBackupOptions): Promise<DbBackupResult> {
  const opts = {
    reason: options.reason,
    dir: options.dir ?? env.BACKUPS_DIR,
    keep: options.keep ?? env.BACKUP_RETENTION_COUNT,
    pgDump: options.pgDump ?? 'pg_dump',
    now: options.now ?? (() => new Date()),
    statfs: options.statfs,
  }
  try {
    return await withAdvisoryLock(DB_BACKUP_LOCK_KEY, () => runLocked(opts))
  } catch (error) {
    const kind = error instanceof BackupError ? error.kind : 'other'
    const message = errorMessage(error)
    logger.error(
      `DATABASE BACKUP FAILED (${opts.reason}): ${message} ` +
        (await newestBackupNote(opts.dir, opts.now())),
    )
    return { status: 'failed', kind, error: message }
  }
}
