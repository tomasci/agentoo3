// How much disk each project occupies, measured with `du` and answered from a
// cache.
//
// A project folder can hold several worktrees' worth of node_modules, so one
// measurement can take tens of seconds — far too long for a request to wait on,
// and far too costly to repeat on every poll. So nothing here is ever awaited
// by a request: `projectDiskUsage` answers from memory immediately and, when
// the numbers are missing or old, starts a measurement in the background for
// the next poll to find. The previous numbers keep being served while that
// runs (stale-while-revalidate), flagged `measuring`, so a number never blinks
// out of the UI merely because it is being refreshed.
//
// The cache lives in this process only. It is a few hundred bytes per project,
// a restart costs one re-measure, and a database column would be a second copy
// of a fact the filesystem already holds.

import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { withoutAppCredentials } from '@/lib/child-env'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectRoot } from '@/lib/paths'
import { readBounded } from '@/lib/spawn'
import type { ProjectDiskUsageDto, ProjectDto } from './schema'

/** A success is trusted this long before a poll triggers a re-measure. */
export const DISK_USAGE_TTL_MS = 5 * 60_000
/** A failure is retried sooner: whatever broke (a folder still being created, a
 * transient read error) is likelier to have changed than a healthy total is. */
export const DISK_USAGE_FAILURE_TTL_MS = 30_000
/** Per `du` invocation. A tree that takes longer than this is not going to
 * finish by being left alone, and an unbounded child is a leak. */
export const DU_TIMEOUT_MS = 120_000
/** Measurements running at once, process-wide. `du` is disk-bound, so more
 * parallelism mostly makes every one of them slower and the machine unpleasant
 * for the sessions it is actually there to run. */
export const MAX_CONCURRENT_MEASUREMENTS = 2

const BYTES_PER_KIB = 1024

/** What a measurement needs to know about a project. A subset of `ProjectDto`
 * so callers pass what they already hold and this module never touches the
 * database. */
export type DiskUsageTarget = Pick<ProjectDto, 'id' | 'slug' | 'source' | 'status'>

type ProjectStatus = DiskUsageTarget['status']

/** Setup is running (or about to): the folder is missing or half-written, and
 * whatever `du` said about it would be wrong again within seconds. */
function isBeingSetUp(status: ProjectStatus): boolean {
  return status === 'pending' || status === 'cloning'
}

export type DiskUsageMeasurement = {
  totalBytes: number
  repoBytes: number
  worktreesBytes: number
}

/** A failure whose message is fit to show an operator as-is, as opposed to an
 * unexpected exception whose text is not. */
export class DiskUsageFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiskUsageFailure'
  }
}

// --- running and reading `du` -----------------------------------------------

export type CommandResult = {
  stdout: string
  stderr: string
  /** Null when the process was killed by a signal — in practice, the timeout. */
  exitCode: number | null
}

/**
 * Run a command to completion and collect its output, killing it after
 * `timeoutMs`. argv only, never a shell: a path with a space or a `;` in it is
 * one argument and nothing more.
 *
 * The env drops this app's own database and Redis credentials, as every other
 * child spawned from here does (see lib/child-env.ts): `du` has no use for
 * them, and nothing that resolves through PATH should be handed them.
 */
export async function runCommand(argv: string[], timeoutMs: number): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    env: withoutAppCredentials(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })

  // readBounded rather than `new Response(stream).text()`: see lib/spawn.ts.
  // Both streams are read the whole way through, because a tree with many
  // unreadable directories makes `du` write a line of stderr for each, and a
  // full pipe would stall it forever.
  const [stdout, stderr] = await Promise.all([
    readBounded(proc.stdout, proc.exited),
    readBounded(proc.stderr, proc.exited),
    proc.exited,
  ])
  return { stdout, stderr: stderr.trim(), exitCode: proc.exitCode }
}

export type DuRunner = (args: string[]) => Promise<CommandResult>

/** `du` with only the flags GNU coreutils and uutils (the Rust rewrite some
 * distros now ship) both accept: `-k`, `-s`, `-d N`. Sizes come back in KiB of
 * allocated blocks, which is what "on disk" means here. */
export const runDu: DuRunner = (args) => runCommand(['du', ...args], DU_TIMEOUT_MS)

/**
 * `du -k` prints `<KiB>\t<path>` per directory. Lines that do not have that
 * shape are skipped rather than trusted: a directory name containing a
 * newline splits one entry across two lines, and the second half is not a
 * size.
 */
export function parseDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\t(.+)$/.exec(line)
    if (!match) continue
    const kib = Number(match[1])
    if (Number.isSafeInteger(kib)) sizes.set(match[2] ?? '', kib)
  }
  return sizes
}

/** The first line of a complaint, for the operator. The rest of a long stderr
 * (`du` writes one line per unreadable directory) would only bury it. */
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Run `du` and return its sizes, requiring one for `path` itself.
 *
 * A non-zero exit does not fail this. `du` exits 1 as soon as any directory in
 * the tree was unreadable — a root-owned directory left behind by a container
 * is enough — but still prints every total it could work out, and a size that
 * is short by the one unreadable directory is far more useful than no size.
 * What fails is not having a total for `path`: nothing printed, or the process
 * was killed before it finished.
 */
async function duSizes(run: DuRunner, args: string[], path: string): Promise<Map<string, number>> {
  const result = await run(args)
  if (result.exitCode === null) {
    throw new DiskUsageFailure(
      `Measuring was stopped before it finished (limit: ${Math.round(DU_TIMEOUT_MS / 1000)}s)`,
    )
  }
  const sizes = parseDuOutput(result.stdout)
  if (!sizes.has(path)) {
    const why = firstLine(result.stderr)
    throw new DiskUsageFailure(`Could not read the folder size${why ? `: ${why}` : ''}`)
  }
  return sizes
}

// --- measuring one project ----------------------------------------------------

/** `lstat`, with "not there" as null and anything else (permissions, a loop)
 * left to throw: only the first is a fact about the project's folders. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Measure the project folder at `root`. `adopted` says its repo/ is (or may
 * be) a link into the operator's own folder.
 *
 * `du` is asked about `root` once, with `-d 1`, which reports the total and
 * each immediate subdirectory in the same pass — so repo/ and worktrees/ cost
 * nothing extra on top of the total. Symlinks are never followed, so a link
 * inside the project (one a tool or an agent planted, say) cannot make the
 * project claim the size of whatever it points at, wherever that is. plugin/ is
 * not special here: it holds copies of the agents and skills assigned to the
 * project (features/library/service.ts), so it is counted like any other
 * directory, once per project.
 *
 * An adopted project is the exception that needs a second `du`. Its repo/ is a
 * symlink, so the pass above sees a link and counts nothing for it, yet the
 * folder it points at is the project's actual checkout and the thing the
 * operator wants the size of. `du` does not follow a link it is handed as an
 * argument either, so it is given the resolved target instead.
 */
export async function measureFolder(
  root: string,
  adopted: boolean,
  run: DuRunner = runDu,
): Promise<DiskUsageMeasurement> {
  const rootStat = await lstatOrNull(root)
  if (!rootStat?.isDirectory()) throw new DiskUsageFailure('Project folder not found')

  const sizes = await duSizes(run, ['-k', '-d', '1', root], root)
  const repo = join(root, 'repo')

  let linkedKib = 0
  let repoIsLinked = false
  if (adopted && (await lstatOrNull(repo))?.isSymbolicLink()) {
    repoIsLinked = true
    // A link whose target was moved or deleted is a repo of nothing, not a
    // measurement failure: there is genuinely no disk behind it.
    const target = await realpath(repo).catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
    if (target) linkedKib = (await duSizes(run, ['-k', '-s', target], target)).get(target) ?? 0
  }

  // `du` prints directories only, so a repo/ that is absent (or a link in a
  // project that is not adopted) has no line of its own and reads as 0 here.
  const repoKib = repoIsLinked ? linkedKib : (sizes.get(repo) ?? 0)
  const worktreesKib = sizes.get(join(root, 'worktrees')) ?? 0

  return {
    totalBytes: ((sizes.get(root) ?? 0) + linkedKib) * BYTES_PER_KIB,
    repoBytes: repoKib * BYTES_PER_KIB,
    worktreesBytes: worktreesKib * BYTES_PER_KIB,
  }
}

export function measureProject(target: DiskUsageTarget): Promise<DiskUsageMeasurement> {
  // slug is ours (toSlug), but it becomes a path handed to a process, so the
  // check deleteProject makes before an `rm` is made here too.
  const root = assertInsideProjects(projectRoot(target.slug))
  return measureFolder(root, target.source === 'existing')
}

// --- the cache and its scheduler ------------------------------------------------

type Entry = {
  /** The last numbers that were successfully taken. Kept across a later
   * failure, so a project that is briefly unreadable keeps its figure. */
  last: (DiskUsageMeasurement & { measuredAt: string }) | null
  /** Why the most recent measurement failed; null if it succeeded. */
  error: string | null
  /** The project status the measurement was scheduled under. A status change
   * (clone finished, a manual fix retried) changes what is on disk, which a
   * TTL cannot know — and this cache lives in the API process, so the worker
   * that makes the change cannot clear it. Comparing against the status the
   * request carries is how a stale answer notices it is stale. */
  status: ProjectStatus
  /** When the most recent measurement finished — what freshness counts from. */
  settledAt: number
}

function createLimiter(max: number) {
  let running = 0
  const waiting: Array<() => void> = []
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (running < max) running += 1
      else await new Promise<void>((resolve) => waiting.push(resolve))
      try {
        return await job()
      } finally {
        // Hand the slot straight to the next in line rather than freeing it and
        // letting it race a newcomer: `running` stays at `max` through the
        // handover, so the limit holds at every instant, not just on average.
        const next = waiting.shift()
        if (next) next()
        else running -= 1
      }
    },
  }
}

const cache = new Map<string, Entry>()
// A token per scheduled measurement, not a boolean: it lets a job that finishes
// after its project was deleted (or the cache reset) see that it no longer owns
// the slot, and drop its result instead of writing an entry nobody will clear.
const inFlight = new Map<string, symbol>()
let limiter = createLimiter(MAX_CONCURRENT_MEASUREMENTS)

function isStale(entry: Entry | undefined, status: ProjectStatus): boolean {
  if (!entry || entry.status !== status) return true
  const ttl = entry.error === null ? DISK_USAGE_TTL_MS : DISK_USAGE_FAILURE_TTL_MS
  return Date.now() - entry.settledAt >= ttl
}

/** Text to show for a failure nobody planned for. The details go to the log;
 * the operator gets enough to know it is not their folder that is wrong. */
function describeFailure(error: unknown): string {
  if (error instanceof DiskUsageFailure) return error.message
  return `Could not measure disk usage: ${firstLine(error instanceof Error ? error.message : String(error))}`
}

async function measureInBackground(
  target: DiskUsageTarget,
  token: symbol,
  measure: typeof measureProject,
): Promise<void> {
  // Queued behind the limiter when it was scheduled; deleted since, if so.
  if (inFlight.get(target.id) !== token) return

  let measured: DiskUsageMeasurement | null = null
  let error: string | null = null
  try {
    measured = await measure(target)
  } catch (thrown) {
    // A folder that is not there yet (a project still pending) is an ordinary
    // state, not something worth a warning every 30 seconds.
    if (thrown instanceof DiskUsageFailure) {
      logger.debug(`Disk usage of ${target.slug}: ${thrown.message}`)
    } else {
      logger.warn(`Disk usage of ${target.slug} could not be measured: ${String(thrown)}`)
    }
    error = describeFailure(thrown)
  }

  if (inFlight.get(target.id) !== token) return
  inFlight.delete(target.id)

  cache.set(target.id, {
    last: measured
      ? { ...measured, measuredAt: new Date().toISOString() }
      : (cache.get(target.id)?.last ?? null),
    error,
    status: target.status,
    settledAt: Date.now(),
  })
}

function schedule(target: DiskUsageTarget, measure: typeof measureProject): void {
  // One measurement per project at a time, however many callers ask — a poll
  // arriving while the last one is still running must not start a second `du`
  // over the same tree.
  if (inFlight.has(target.id)) return

  const token = Symbol(target.id)
  inFlight.set(target.id, token)
  // Nothing awaits this, so it must not be able to reject: measureInBackground
  // already turns a failed measurement into a cache entry, and this catch is
  // for what it did not anticipate (the logger throwing, say). An unhandled
  // rejection here would take down a process that serves everything else.
  limiter
    .run(() => measureInBackground(target, token, measure))
    .catch((thrown) => {
      if (inFlight.get(target.id) === token) inFlight.delete(target.id)
      logger.warn(`Disk usage scheduling for ${target.slug} failed: ${String(thrown)}`)
    })
}

/**
 * What is known about a project's disk usage right now, without waiting for
 * anything. Starts a background measurement when there is no entry, it has
 * outlived its TTL, or it was taken under a different project status — or
 * always, with `force`, which is the refresh button; a measurement already in
 * flight is joined rather than doubled either way.
 *
 * A project still being set up (`pending`, `cloning`) is never measured, force
 * or not: its folder is missing or half-written, so the answer would be an
 * error or a number that is wrong by the time it is shown, and either would
 * then be served from cache after setup finishes. It gets whatever the cache
 * already holds. Once the status changes, the first request re-measures.
 *
 * Scheduling comes before reading so that the very first call for a project
 * already reports `measuring: true`: a client that polls while that is true
 * must not be told "nothing is happening" about a measurement that is about
 * to start.
 *
 * `measure` is a parameter only so the scheduling can be tested with a
 * measurement that does what the test says; callers pass nothing.
 */
export function projectDiskUsage(
  target: DiskUsageTarget,
  options: { force?: boolean; measure?: typeof measureProject } = {},
): ProjectDiskUsageDto {
  const entry = cache.get(target.id)
  if (!isBeingSetUp(target.status) && (options.force || isStale(entry, target.status))) {
    schedule(target, options.measure ?? measureProject)
  }

  // Numbers from another status are still shown while the re-measurement runs
  // (stale-while-revalidate), but the reason a measurement failed belongs to
  // the status it failed under: "Project folder not found" from the clone
  // phase must not greet a project that is ready now.
  const error = entry?.status === target.status ? entry.error : null

  return {
    projectId: target.id,
    totalBytes: entry?.last?.totalBytes ?? null,
    repoBytes: entry?.last?.repoBytes ?? null,
    worktreesBytes: entry?.last?.worktreesBytes ?? null,
    measuredAt: entry?.last?.measuredAt ?? null,
    measuring: inFlight.has(target.id),
    error,
  }
}

/** Forget a deleted project, including a measurement still queued or running
 * for it: its result is discarded when it lands. */
export function forgetProjectDiskUsage(projectId: string): void {
  cache.delete(projectId)
  inFlight.delete(projectId)
}

/** Test-only: a clean slate between tests. A measurement still running from a
 * previous test no longer owns its slot, so its result is dropped on arrival. */
export function resetDiskUsageForTests(): void {
  cache.clear()
  inFlight.clear()
  limiter = createLimiter(MAX_CONCURRENT_MEASUREMENTS)
}
