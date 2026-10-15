// Runs real Postgres backups through runDbBackup (features/backups/
// service.ts) against the throwaway cluster db-backup-db.test.ts started:
// the advisory lock, the server-version preflight, the boot/scheduled
// freshness skips (and a backup named in the future, which must not count),
// the clean-up of partials a crash left, the free-space refusal and
// retention, with the real pg_dump underneath a wrapper that records the
// argv and environment it was started with. Prints what happened as JSON;
// every assertion lives in the parent.
//
// A child process for the reason every *-db-child.ts is one: @/env parses
// DATABASE_URL and BACKUPS_DIR once per process, and the shared test process
// has them pointed elsewhere.

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeDb } from '@/db/client'
import { env } from '@/env'
import { backupFileName, parseBackupFileName, type StatFs } from '@/features/backups/dump'
import { type RunDbBackupOptions, runDbBackup } from '@/features/backups/service'
import { assertDisposableTestDb } from './disposable-db-guard'

// Before anything below can reach DATABASE_URL: refuse to run unless it is a
// throwaway cluster from pg-cluster.ts (see disposable-db-guard.ts).
await assertDisposableTestDb()

const facts: Record<string, unknown> = {}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run this through db-backup-db.test.ts`)
  return value
}

const REAL_PG_DUMP = required('REAL_PG_DUMP')
const CAPTURE = required('CAPTURE_DIR')
const dir = env.BACKUPS_DIR

const GiB = 1024 ** 3
/** statfs for a filesystem of `total` bytes with `free` available. */
const fakeStatfs =
  (total: number, free: number): StatFs =>
  async () => ({ bsize: 4096, frsize: 4096, blocks: total / 4096, bavail: free / 4096 })
/** 1 TiB, half of it free: whatever the disk under /tmp has, the free-space
 * check passes. Only scenario 8 is about that check. */
const ROOMY = fakeStatfs(1024 * GiB, 512 * GiB)
/** 100 GiB with exactly the 10 GiB reserve free: any dump at all is refused. */
const FULL = fakeStatfs(100 * GiB, 10 * GiB)

const backup = (opts: RunDbBackupOptions) => runDbBackup({ statfs: ROOMY, ...opts })

/**
 * The real pg_dump, behind a script that first writes down its own
 * /proc/<pid>/cmdline (exactly what `ps` would show for the process
 * runDbBackup spawned) and environment, and logs when each call started and
 * ended. Dump calls (not `--version`) sleep a second first, so two dumps
 * that were not serialised would visibly overlap.
 */
async function writeWrapper(): Promise<string> {
  await mkdir(CAPTURE, { recursive: true })
  const path = join(CAPTURE, 'pg_dump-wrapper')
  await writeFile(
    path,
    `#!/bin/sh
tr '\\0' '\\n' < /proc/$$/cmdline > '${CAPTURE}/cmdline-'$$
env > '${CAPTURE}/env-'$$
echo "start $$ $1 $(date +%s%N)" >> '${CAPTURE}/calls.log'
if [ "$1" != "--version" ]; then sleep 1; fi
'${REAL_PG_DUMP}' "$@"
rc=$?
echo "end $$ $1 $(date +%s%N)" >> '${CAPTURE}/calls.log'
exit $rc
`,
  )
  await chmod(path, 0o755)
  return path
}

async function listing(): Promise<string[]> {
  return (await readdir(dir)).sort()
}

async function dumpCalls(): Promise<{ pid: string; start: number; end: number }[]> {
  const log = await readFile(join(CAPTURE, 'calls.log'), 'utf8').catch(() => '')
  const calls = new Map<string, { pid: string; start: number; end: number }>()
  for (const line of log.split('\n')) {
    const [event, pid, first, ns] = line.split(' ')
    if (!pid || first !== '--format=custom') continue
    const call = calls.get(pid) ?? { pid, start: 0, end: 0 }
    if (event === 'start') call.start = Number(ns) / 1e6
    if (event === 'end') call.end = Number(ns) / 1e6
    calls.set(pid, call)
  }
  return [...calls.values()].sort((a, b) => a.start - b.start)
}

try {
  const wrapper = await writeWrapper()

  // 1. One real backup.
  {
    const result = await backup({ reason: 'manual', pgDump: wrapper })
    const files = await listing()
    const name = result.status === 'created' ? result.path.slice(dir.length + 1) : ''
    facts.first = {
      result,
      files,
      name,
      nameParses: Boolean(parseBackupFileName(name)),
      fileMode: name ? (await stat(join(dir, name))).mode & 0o777 : null,
      dirMode: (await stat(dir)).mode & 0o777,
    }
  }

  // 2. Two at once: the advisory lock makes the second wait for the first.
  {
    const results = await Promise.all([
      backup({ reason: 'manual', pgDump: wrapper }),
      backup({ reason: 'manual', pgDump: wrapper }),
    ])
    facts.concurrent = {
      statuses: results.map((r) => r.status),
      calls: await dumpCalls(),
      // BACKUP_RETENTION_COUNT is 2 for this run: three backups taken, the
      // oldest deleted by the third.
      files: await listing(),
      deletedByLast: results.flatMap((r) => (r.status === 'created' ? r.deleted : [])),
    }
  }

  // 3. The freshness skips: everything on disk is seconds old. A partial a
  // crashed run left a moment ago goes all the same, even on a run that
  // skips; a stranger's file of the same shape stays.
  {
    const before = (await dumpCalls()).length
    const orphan = `${backupFileName(new Date())}.partial`
    const foreign = 'otherdb-20261015T023000Z.dump.partial'
    await writeFile(join(dir, orphan), 'half a dump')
    await writeFile(join(dir, foreign), 'not ours')
    const boot = await backup({ reason: 'boot', pgDump: wrapper })
    const afterBoot = await listing()
    const scheduled = await backup({ reason: 'scheduled', pgDump: wrapper })
    facts.freshSkips = {
      boot,
      scheduled,
      newDumpCalls: (await dumpCalls()).length - before,
      orphan,
      foreign,
      afterBoot,
    }
    await rm(join(dir, foreign))
  }

  // 4. pg_dump older than the server: refused before anything is written.
  {
    const old = join(CAPTURE, 'pg_dump-old')
    await writeFile(old, "#!/bin/sh\necho 'pg_dump (PostgreSQL) 9.6.24'\n")
    await chmod(old, 0o755)
    const before = await listing()
    const result = await backup({ reason: 'manual', pgDump: old })
    facts.tooOld = { result, unchanged: JSON.stringify(await listing()) === JSON.stringify(before) }
  }

  // 5. No pg_dump at all: a logged failure, not a crash.
  {
    const before = await listing()
    const result = await backup({ reason: 'manual', pgDump: '/nonexistent/pg_dump' })
    facts.missing = { result, unchanged: JSON.stringify(await listing()) === JSON.stringify(before) }
  }

  // 6. The boot catch-up once the newest backup is over a day old: age every
  // backup on disk by two days (by name, which is what the check reads).
  {
    for (const name of await listing()) {
      const takenAt = parseBackupFileName(name)
      if (!takenAt) continue
      const older = backupFileName(new Date(takenAt.getTime() - 2 * 24 * 60 * 60 * 1000))
      await rename(join(dir, name), join(dir, older))
    }
    const result = await backup({ reason: 'boot', pgDump: wrapper })
    facts.bootStale = { result, files: await listing() }
  }

  // What every dump call was started with.
  {
    const captured = (await readdir(CAPTURE)).filter((n) => n.startsWith('cmdline-'))
    const calls: { cmdline: string; env: string }[] = []
    for (const file of captured) {
      const pid = file.slice('cmdline-'.length)
      calls.push({
        cmdline: await readFile(join(CAPTURE, file), 'utf8'),
        env: await readFile(join(CAPTURE, `env-${pid}`), 'utf8'),
      })
    }
    facts.spawned = { calls }
  }

  // 7. A backup named a year ahead (written while the clock was wrong) must
  // not pass for a fresh one: the daily and the boot run each still take a
  // real dump. Each in a directory of its own. The scheduled one also has two
  // real backups, days old, and keeps 1: retention deletes both of those and
  // neither the future file nor the dump just taken.
  for (const reason of ['scheduled', 'boot'] as const) {
    const skewDir = join(CAPTURE, `skew-${reason}`)
    await mkdir(skewDir, { recursive: true, mode: 0o700 })
    const now = Date.now()
    const future = backupFileName(new Date(now + 365 * 24 * 60 * 60 * 1000))
    await writeFile(join(skewDir, future), 'taken while the clock was a year ahead')
    const old =
      reason === 'scheduled'
        ? [2, 3].map((days) => backupFileName(new Date(now - days * 24 * 60 * 60 * 1000)))
        : []
    for (const name of old) await writeFile(join(skewDir, name), 'an older backup')
    const result = await backup({ reason, pgDump: wrapper, dir: skewDir, keep: 1 })
    const files = (await readdir(skewDir)).sort()
    const written = result.status === 'created' ? result.path : ''
    facts[`skew-${reason}`] = {
      result,
      future,
      old,
      files,
      written: written.slice(skewDir.length + 1),
      header: written ? (await readFile(written)).subarray(0, 5).toString('latin1') : '',
      futureIntact:
        (await readFile(join(skewDir, future), 'utf8')) === 'taken while the clock was a year ahead',
    }
  }

  // 8. Not enough room: refused before pg_dump is started, nothing written,
  // and reported as the failure it is. Once with backups on disk (the newest
  // one is the size estimate), once in an empty directory (the database's
  // own size is).
  {
    const dumpsBefore = (await dumpCalls()).length
    const before = await listing()
    const full = await backup({ reason: 'manual', pgDump: wrapper, statfs: FULL })
    const emptyDir = join(CAPTURE, 'space-empty')
    const empty = await backup({ reason: 'manual', pgDump: wrapper, statfs: FULL, dir: emptyDir })
    facts.space = {
      full,
      empty,
      newest: before.filter((n) => parseBackupFileName(n)).at(-1),
      unchanged: JSON.stringify(await listing()) === JSON.stringify(before),
      emptyFiles: await readdir(emptyDir),
      newDumpCalls: (await dumpCalls()).length - dumpsBefore,
    }
  }

  await closeDb()
  console.log(`__FACTS__${JSON.stringify(facts)}`)
  process.exit(0)
} catch (error) {
  console.log(`__ERROR__${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  await closeDb().catch(() => {})
  process.exit(1)
}
