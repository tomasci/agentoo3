// features/projects/disk-usage.ts: parsing `du`, measuring real directory
// trees with the real `du`, and the cache/scheduler around it.
//
// No database and no module mocks: the measurement takes plain paths, and the
// scheduler takes its `measure` as a parameter, so everything here runs in the
// shared test process. The HTTP side of this feature (three routes, 404s, the
// `/projects/disk-usage` vs `/projects/{id}` ordering) needs the real service
// and a faked database, so it lives in projects-disk-usage-routes.scenarios.ts.

import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import './setup-env'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type CommandResult,
  DISK_USAGE_FAILURE_TTL_MS,
  DISK_USAGE_TTL_MS,
  DiskUsageFailure,
  type DiskUsageMeasurement,
  type DiskUsageTarget,
  type DuRunner,
  forgetProjectDiskUsage,
  MAX_CONCURRENT_MEASUREMENTS,
  measureFolder,
  parseDuOutput,
  projectDiskUsage,
  resetDiskUsageForTests,
  runCommand,
  runDu,
} from '../src/features/projects/disk-usage'

const KIB = 1024

// --- fixtures -------------------------------------------------------------------

let scratch = ''
let counter = 0

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentoo-disk-usage-'))
})

afterAll(async () => {
  // A test below leaves a directory it made unreadable; rm cannot descend into
  // that, so it is made readable again first.
  await chmod(join(scratch, 'locked-root', 'locked'), 0o755).catch(() => {})
  await rm(scratch, { recursive: true, force: true })
})

afterEach(() => {
  setSystemTime()
  resetDiskUsageForTests()
})

/** A fresh, empty directory inside the scratch area. */
async function freshDir(name = 'p'): Promise<string> {
  counter += 1
  const dir = join(scratch, `${counter}`, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** A file of `bytes` of random data: random so that a filesystem that
 * compresses or deduplicates cannot make "on disk" smaller than the test says. */
async function fill(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, randomBytes(bytes))
}

/** `[lo, hi)` in bytes: block rounding and directory entries make a measured
 * size land a little above the data written, never below it. */
function between(actual: number, lo: number, slack = 64 * KIB) {
  expect(actual).toBeGreaterThanOrEqual(lo)
  expect(actual).toBeLessThan(lo + slack)
}

/** A `du` that records what it was asked and then really runs. */
function countingDu() {
  const calls: string[][] = []
  const run: DuRunner = (args) => {
    calls.push(args)
    return runDu(args)
  }
  return { calls, run }
}

const ok = (stdout: string, exitCode = 0, stderr = ''): CommandResult => ({
  stdout,
  stderr,
  exitCode,
})

// --- parsing --------------------------------------------------------------------

describe('parseDuOutput', () => {
  test('reads one KiB-and-path pair per line', () => {
    const sizes = parseDuOutput('4\t/p/plugin\n52\t/p/worktrees\n100\t/p/repo\n156\t/p\n')
    expect(sizes.get('/p/plugin')).toBe(4)
    expect(sizes.get('/p/worktrees')).toBe(52)
    expect(sizes.get('/p/repo')).toBe(100)
    expect(sizes.get('/p')).toBe(156)
    expect(sizes.size).toBe(4)
  })

  test('keeps a path with spaces, tabs and a leading digit', () => {
    const sizes = parseDuOutput('8\t/p/my project\n12\t/p/a\tb\n3\t/p/9 lives\n')
    expect(sizes.get('/p/my project')).toBe(8)
    expect(sizes.get('/p/a\tb')).toBe(12)
    expect(sizes.get('/p/9 lives')).toBe(3)
  })

  test('skips what is not a size line instead of misreading it', () => {
    const sizes = parseDuOutput(
      [
        "du: cannot read directory '/p/locked': Permission denied",
        '',
        'not-a-number\t/p/x',
        '-5\t/p/negative',
        '12 /p/space-not-tab',
        '\t/p/no-size',
        '7\t',
        '20\t/p',
      ].join('\n'),
    )
    expect([...sizes.entries()]).toEqual([['/p', 20]])
  })

  test('is empty for empty output', () => {
    expect(parseDuOutput('').size).toBe(0)
  })

  test('refuses a size too large to be exact rather than rounding it', () => {
    expect(parseDuOutput('99999999999999999999\t/p\n').size).toBe(0)
  })
})

// --- running a child --------------------------------------------------------------

describe('runCommand', () => {
  test('returns stdout, stderr and the exit code of a failing command', async () => {
    const result = await runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3'], 10_000)
    expect(result).toEqual({ stdout: 'out\n', stderr: 'err', exitCode: 3 })
  })

  test('passes an argument with shell metacharacters through untouched', async () => {
    const result = await runCommand(['echo', 'a; echo injected $(id) `id`'], 10_000)
    expect(result.stdout).toBe('a; echo injected $(id) `id`\n')
  })

  test('kills a command that outlives its timeout and reports no exit code', async () => {
    const started = Date.now()
    const result = await runCommand(['sleep', '30'], 150)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('does not hand the app database or Redis credentials to the child', async () => {
    // setup-env gives this process a DATABASE_URL, so it is there to be withheld.
    expect(process.env.DATABASE_URL).toBeDefined()
    const result = await runCommand(['sh', '-c', 'echo "$' + '{DATABASE_URL:-absent}"'], 10_000)
    expect(result.stdout.trim()).toBe('absent')
  })
})

// --- what `du` reports, as the measurement reads it ---------------------------------

describe('measuring with a stubbed du', () => {
  test('accepts a usable total even when du exits non-zero', async () => {
    const root = await freshDir()
    const run: DuRunner = async () =>
      ok(
        [`0\t${root}/locked`, `40\t${root}/worktrees`, `100\t${root}/repo`, `150\t${root}`].join(
          '\n',
        ),
        1,
        `du: cannot read directory '${root}/locked': Permission denied`,
      )
    expect(await measureFolder(root, false, run)).toEqual({
      totalBytes: 150 * KIB,
      repoBytes: 100 * KIB,
      worktreesBytes: 40 * KIB,
    })
  })

  test('fails, quoting du, when there is no total line for the folder', async () => {
    const root = await freshDir()
    const run: DuRunner = async () =>
      ok('', 1, `du: cannot access '${root}': Input/output error\nmore`)
    const failure = await measureFolder(root, false, run).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DiskUsageFailure)
    expect((failure as Error).message).toBe(
      `Could not read the folder size: du: cannot access '${root}': Input/output error`,
    )
  })

  test('fails when a total is printed for some other path only', async () => {
    const root = await freshDir()
    const run: DuRunner = async () => ok('10\t/somewhere/else\n', 1)
    await expect(measureFolder(root, false, run)).rejects.toBeInstanceOf(DiskUsageFailure)
  })

  test('fails, whatever was printed, when du was killed for running too long', async () => {
    const root = await freshDir()
    // Partial output from a killed du is not a total, whatever it happens to contain.
    const run: DuRunner = async () => ({ stdout: `10\t${root}\n`, stderr: '', exitCode: null })
    await expect(measureFolder(root, false, run)).rejects.toThrow('stopped before it finished')
  })

  test('asks du for the root once with -d 1, and for nothing else when not adopted', async () => {
    const root = await freshDir()
    const { calls, run } = countingDu()
    await measureFolder(root, false, run)
    expect(calls).toEqual([['-k', '-d', '1', root]])
  })
})

// --- measuring real trees with the real du --------------------------------------------

describe('measuring a real project folder', () => {
  test('splits the total into repo and worktrees, and counts each only once', async () => {
    const root = await freshDir()
    await fill(join(root, 'repo', 'src', 'a.bin'), 256 * KIB)
    await fill(join(root, 'worktrees', 's1', 'b.bin'), 128 * KIB)
    await fill(join(root, 'worktrees', 's2', 'c.bin'), 64 * KIB)
    await fill(join(root, 'env', '.env'), 8 * KIB)

    const result = await measureFolder(root, false)
    between(result.repoBytes, 256 * KIB)
    between(result.worktreesBytes, 192 * KIB)
    between(result.totalBytes, (256 + 192 + 8) * KIB)
    expect(result.totalBytes).toBeGreaterThanOrEqual(result.repoBytes + result.worktreesBytes)
  })

  test('is the number du itself gives for the whole folder', async () => {
    const root = await freshDir()
    await fill(join(root, 'repo', 'a.bin'), 100 * KIB)
    await fill(join(root, 'worktrees', 's1', 'b.bin'), 100 * KIB)
    await fill(join(root, 'loose.bin'), 20 * KIB)

    const du = await runDu(['-k', '-s', root])
    const expected = parseDuOutput(du.stdout).get(root)
    expect(expected).toBeGreaterThan(0)
    expect((await measureFolder(root, false)).totalBytes).toBe((expected ?? 0) * KIB)
  })

  test('never follows a symlink inside the project — only the link itself is counted', async () => {
    // A big folder outside the project, of the kind a tool might link to.
    const elsewhere = await freshDir('elsewhere')
    await fill(join(elsewhere, 'docs', 'guide.md'), 2048 * KIB)
    await fill(join(elsewhere, 'cache', 'blob.bin'), 2048 * KIB)

    const root = await freshDir()
    await fill(join(root, 'repo', 'a.bin'), 64 * KIB)
    await mkdir(join(root, 'links'), { recursive: true })
    await symlink(join(elsewhere, 'docs', 'guide.md'), join(root, 'links', 'guide.md'))
    await symlink(join(elsewhere, 'cache'), join(root, 'links', 'cache'), 'dir')
    await symlink(elsewhere, join(root, 'links', 'everything'), 'dir')

    const result = await measureFolder(root, false)
    // 4 MiB sits behind those links; the folder holds 64 KiB of data.
    between(result.totalBytes, 64 * KIB)
    between(result.repoBytes, 64 * KIB)
  })

  test('counts plugin/, which holds copies of the assigned agents and skills', async () => {
    const root = await freshDir()
    await fill(join(root, 'repo', 'a.bin'), 64 * KIB)
    await fill(join(root, 'plugin', 'agents', 'orchestrator.md'), 64 * KIB)
    await fill(join(root, 'plugin', 'skills', 'testing', 'SKILL.md'), 128 * KIB)

    const result = await measureFolder(root, false)
    between(result.totalBytes, (64 + 64 + 128) * KIB)
    // Part of the total, not of repo/ or worktrees/.
    between(result.repoBytes, 64 * KIB)
    expect(result.worktreesBytes).toBe(0)
  })

  test('counts the folder an adopted project links to, in total and as repo', async () => {
    const source = await freshDir('operator-folder')
    await fill(join(source, 'app', 'main.bin'), 512 * KIB)
    await fill(join(source, 'node_modules', 'dep.bin'), 256 * KIB)

    const root = await freshDir()
    await fill(join(root, 'worktrees', 's1', 'w.bin'), 64 * KIB)
    await symlink(source, join(root, 'repo'), 'dir')

    const { calls, run } = countingDu()
    const result = await measureFolder(root, true, run)

    between(result.repoBytes, 768 * KIB)
    between(result.worktreesBytes, 64 * KIB)
    between(result.totalBytes, (768 + 64) * KIB)
    expect(result.totalBytes).toBeGreaterThanOrEqual(result.repoBytes + result.worktreesBytes)
    // One pass over the root, one over the linked folder — never a third.
    expect(calls).toEqual([
      ['-k', '-d', '1', root],
      ['-k', '-s', source],
    ])
  })

  test('hands du the resolved target of the link, not the link', async () => {
    const source = await freshDir('operator-folder')
    await fill(join(source, 'a.bin'), 128 * KIB)
    const hop = await freshDir('hop')
    await symlink(source, join(hop, 'second'), 'dir')
    const root = await freshDir()
    await symlink(join(hop, 'second'), join(root, 'repo'), 'dir')

    const { calls, run } = countingDu()
    const result = await measureFolder(root, true, run)
    // realpath resolved both hops; du given the link itself would report ~0.
    expect(calls[1]).toEqual(['-k', '-s', await realpath(source)])
    between(result.repoBytes, 128 * KIB)
  })

  test('does not follow repo/ for a project that is not adopted', async () => {
    const elsewhere = await freshDir('elsewhere')
    await fill(join(elsewhere, 'a.bin'), 512 * KIB)
    const root = await freshDir()
    await symlink(elsewhere, join(root, 'repo'), 'dir')

    const { calls, run } = countingDu()
    const result = await measureFolder(root, false, run)
    expect(calls).toHaveLength(1)
    expect(result.repoBytes).toBeLessThan(64 * KIB)
    expect(result.totalBytes).toBeLessThan(64 * KIB)
  })

  test('reads a repo/ link whose target is gone as a repo of nothing', async () => {
    const root = await freshDir()
    await fill(join(root, 'worktrees', 's1', 'w.bin'), 64 * KIB)
    await symlink(join(scratch, 'does-not-exist'), join(root, 'repo'), 'dir')

    const result = await measureFolder(root, true)
    expect(result.repoBytes).toBe(0)
    between(result.worktreesBytes, 64 * KIB)
  })

  test('reports 0 for worktrees/ when there is no such directory', async () => {
    const root = await freshDir()
    await fill(join(root, 'repo', 'a.bin'), 64 * KIB)

    const result = await measureFolder(root, false)
    expect(result.worktreesBytes).toBe(0)
    between(result.repoBytes, 64 * KIB)
  })

  test('reports 0 for repo/ when there is no such directory yet', async () => {
    const root = await freshDir()
    await fill(join(root, 'worktrees', 's1', 'w.bin'), 64 * KIB)
    expect((await measureFolder(root, false)).repoBytes).toBe(0)
  })

  test('fails with "Project folder not found" for a missing root, without running du', async () => {
    const { calls, run } = countingDu()
    const failure = await measureFolder(join(scratch, 'never-created'), false, run).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(DiskUsageFailure)
    expect((failure as Error).message).toBe('Project folder not found')
    expect(calls).toHaveLength(0)
  })

  test('fails the same way when the root is a file, not a folder', async () => {
    const dir = await freshDir()
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    await expect(measureFolder(file, false)).rejects.toThrow('Project folder not found')
  })

  test('measures a root whose name has spaces and shell metacharacters', async () => {
    const root = await freshDir('we ird; $(touch pwned) `x`')
    await fill(join(root, 'repo', 'a.bin'), 64 * KIB)
    between((await measureFolder(root, false)).repoBytes, 64 * KIB)
    expect(await Bun.file(join(dirname(root), 'pwned')).exists()).toBe(false)
  })

  // du exits 1 on an unreadable directory but still prints totals. Not
  // reproducible as root, which can read everything.
  test.skipIf(process.getuid?.() === 0)(
    'still reports a total when part of the tree is unreadable',
    async () => {
      const root = join(scratch, 'locked-root')
      await fill(join(root, 'repo', 'a.bin'), 128 * KIB)
      await fill(join(root, 'locked', 'hidden.bin'), 64 * KIB)
      await chmod(join(root, 'locked'), 0o000)

      const raw = await runDu(['-k', '-d', '1', root])
      expect(raw.exitCode).not.toBe(0)

      const result = await measureFolder(root, false)
      between(result.repoBytes, 128 * KIB)
      expect(result.totalBytes).toBeGreaterThanOrEqual(result.repoBytes)
    },
  )
})

// --- the cache and its scheduler --------------------------------------------------------

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const target = (
  id = ID_A,
  source: DiskUsageTarget['source'] = 'clone',
  status: DiskUsageTarget['status'] = 'ready',
): DiskUsageTarget => ({
  id,
  slug: `slug-${id.slice(0, 4)}`,
  source,
  status,
})

const numbers = (n: number): DiskUsageMeasurement => ({
  totalBytes: n * 3,
  repoBytes: n,
  worktreesBytes: n * 2,
})

/** A measurement the test finishes by hand. */
function deferredMeasure() {
  const started: DiskUsageTarget[] = []
  const pending: Array<{
    resolve: (value: DiskUsageMeasurement) => void
    reject: (reason: unknown) => void
  }> = []
  const measure = (t: DiskUsageTarget) => {
    started.push(t)
    return new Promise<DiskUsageMeasurement>((resolve, reject) => pending.push({ resolve, reject }))
  }
  return { measure, started, pending }
}

/** Let every already-settled promise run its continuations. */
const flush = () => Bun.sleep(0)

/** A measure that must not be reached — for polling a project the test expects
 * to be in flight or fresh, where nothing should be scheduled. */
const unexpected = (): Promise<DiskUsageMeasurement> => {
  throw new Error('a measurement was scheduled that the test did not expect')
}

describe('projectDiskUsage', () => {
  test('first call: nothing known yet, but a measurement is already under way', () => {
    const { measure } = deferredMeasure()
    const usage = projectDiskUsage(target(), { measure })
    expect(usage).toEqual({
      projectId: ID_A,
      totalBytes: null,
      repoBytes: null,
      worktreesBytes: null,
      measuredAt: null,
      measuring: true,
      error: null,
    })
  })

  test('never waits for the measurement', () => {
    const { measure } = deferredMeasure() // never resolves
    const startedAt = Date.now()
    projectDiskUsage(target(), { measure })
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  test('once the measurement lands: the numbers, when they were taken, and not measuring', async () => {
    setSystemTime(new Date('2026-03-04T05:06:07.000Z'))
    const { measure, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(100))
    await flush()

    expect(projectDiskUsage(target(), { measure: unexpected })).toEqual({
      projectId: ID_A,
      totalBytes: 300,
      repoBytes: 100,
      worktreesBytes: 200,
      measuredAt: '2026-03-04T05:06:07.000Z',
      measuring: false,
      error: null,
    })
  })

  test('concurrent requests for one project run one du, real du included', async () => {
    const root = await freshDir()
    await fill(join(root, 'repo', 'a.bin'), 64 * KIB)
    const { calls, run } = countingDu()
    const measure = async () => measureFolder(root, false, run)

    // A burst: two plain polls, a forced refresh, and another poll — as a UI
    // polling the list while someone presses "refresh" would produce.
    const burst = [
      projectDiskUsage(target(), { measure }),
      projectDiskUsage(target(), { measure }),
      projectDiskUsage(target(), { measure, force: true }),
      projectDiskUsage(target(), { measure }),
    ]
    expect(burst.every((usage) => usage.measuring)).toBe(true)

    let usage = projectDiskUsage(target(), { measure: unexpected })
    for (let i = 0; i < 200 && usage.measuring; i += 1) {
      await Bun.sleep(10)
      usage = projectDiskUsage(target(), { measure: unexpected })
    }
    expect(usage.measuring).toBe(false)
    expect(usage.error).toBeNull()
    between(usage.repoBytes ?? -1, 64 * KIB)
    expect(calls).toHaveLength(1)
  })

  test('different projects are measured independently', async () => {
    const { measure, started } = deferredMeasure()
    projectDiskUsage(target(ID_A), { measure })
    projectDiskUsage(target(ID_B), { measure })
    await flush()
    expect(started.map((t) => t.id)).toEqual([ID_A, ID_B])
  })

  test('a fresh success is not measured again until its TTL is up', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(1))
    await flush()

    setSystemTime(new Date(Date.now() + DISK_USAGE_TTL_MS - 1))
    expect(projectDiskUsage(target(), { measure }).measuring).toBe(false)
    await flush()
    expect(started).toHaveLength(1)

    setSystemTime(new Date(Date.now() + 1))
    expect(projectDiskUsage(target(), { measure }).measuring).toBe(true)
    await flush()
    expect(started).toHaveLength(2)
  })

  test('stale-while-revalidate: old numbers stay, flagged measuring, until the new ones land', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(100))
    await flush()

    setSystemTime(new Date(Date.now() + DISK_USAGE_TTL_MS + 1000))
    const during = projectDiskUsage(target(), { measure })
    expect(during).toMatchObject({
      totalBytes: 300,
      repoBytes: 100,
      worktreesBytes: 200,
      measuredAt: '2026-03-04T10:00:00.000Z',
      measuring: true,
      error: null,
    })
    await flush()
    // Still the old numbers while the new measurement is running.
    expect(projectDiskUsage(target(), { measure: unexpected })).toMatchObject({
      totalBytes: 300,
      measuring: true,
    })

    pending[1]?.resolve(numbers(500))
    await flush()
    const after = projectDiskUsage(target(), { measure: unexpected })
    expect(after).toMatchObject({ totalBytes: 1500, repoBytes: 500, measuring: false, error: null })
    expect(after.measuredAt).toBe(new Date().toISOString())
  })

  test('refresh measures again although the cached numbers are fresh, keeping them meanwhile', async () => {
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(10))
    await flush()
    expect(projectDiskUsage(target(), { measure: unexpected }).measuring).toBe(false)

    const refreshed = projectDiskUsage(target(), { measure, force: true })
    expect(refreshed).toMatchObject({ measuring: true, totalBytes: 30 })
    await flush()
    expect(started).toHaveLength(2)

    // A second refresh while that one is running joins it.
    projectDiskUsage(target(), { measure, force: true })
    await flush()
    expect(started).toHaveLength(2)
  })

  test('a failure with nothing before it: null numbers and the reason', async () => {
    const { measure, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.reject(new DiskUsageFailure('Project folder not found'))
    await flush()

    expect(projectDiskUsage(target(), { measure: unexpected })).toEqual({
      projectId: ID_A,
      totalBytes: null,
      repoBytes: null,
      worktreesBytes: null,
      measuredAt: null,
      measuring: false,
      error: 'Project folder not found',
    })
  })

  test('a failure after a success keeps the last numbers and their timestamp', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(100))
    await flush()

    projectDiskUsage(target(), { measure, force: true })
    await flush()
    pending[1]?.reject(new DiskUsageFailure('Could not read the folder size: du: boom'))
    await flush()

    expect(projectDiskUsage(target(), { measure: unexpected })).toEqual({
      projectId: ID_A,
      totalBytes: 300,
      repoBytes: 100,
      worktreesBytes: 200,
      measuredAt: '2026-03-04T10:00:00.000Z',
      measuring: false,
      error: 'Could not read the folder size: du: boom',
    })
  })

  test('a failure is retried after 30 seconds, not 5 minutes, and a success clears it', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.reject(new DiskUsageFailure('nope'))
    await flush()

    setSystemTime(new Date(Date.now() + DISK_USAGE_FAILURE_TTL_MS - 1))
    expect(projectDiskUsage(target(), { measure }).measuring).toBe(false)
    expect(started).toHaveLength(1)

    setSystemTime(new Date(Date.now() + 1))
    const retry = projectDiskUsage(target(), { measure })
    expect(retry).toMatchObject({ measuring: true, error: 'nope' })
    await flush()
    pending[1]?.resolve(numbers(7))
    await flush()
    expect(projectDiskUsage(target(), { measure: unexpected })).toMatchObject({
      totalBytes: 21,
      error: null,
      measuring: false,
    })
  })

  test('an unexpected exception is reported plainly, not as a stack', async () => {
    const { measure, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.reject(
      new Error("EACCES: permission denied, lstat '/p/x'\n    at secret (file.ts:1)"),
    )
    await flush()
    expect(projectDiskUsage(target(), { measure: unexpected }).error).toBe(
      "Could not measure disk usage: EACCES: permission denied, lstat '/p/x'",
    )
  })

  test('a measurement that throws synchronously becomes an error entry too', async () => {
    const measure = (): Promise<DiskUsageMeasurement> => {
      throw new Error('thrown before any promise existed')
    }
    projectDiskUsage(target(), { measure })
    await flush()
    expect(projectDiskUsage(target(), { measure: unexpected })).toMatchObject({
      measuring: false,
      error: 'Could not measure disk usage: thrown before any promise existed',
    })
  })

  test('no measurement failure becomes an unhandled rejection', async () => {
    const seen: unknown[] = []
    const listener = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const { measure, pending } = deferredMeasure()
      projectDiskUsage(target(ID_A), { measure })
      projectDiskUsage(target(ID_B), { measure })
      await flush()
      pending[0]?.reject(new DiskUsageFailure('expected kind'))
      pending[1]?.reject(new TypeError('unexpected kind'))
      await Bun.sleep(20)
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  test('at most 2 measurements run at once; the rest queue, and still report measuring', async () => {
    // The literal, not the constant: a test that reads the limit from the code
    // under test passes for whatever the limit is changed to.
    expect(MAX_CONCURRENT_MEASUREMENTS).toBe(2)
    const ids = ['1', '2', '3', '4', '5'].map((n) => `${n.repeat(8)}-1111-4111-8111-111111111111`)
    let running = 0
    let peak = 0
    const release: Array<() => void> = []
    const started: string[] = []
    const measure = (t: DiskUsageTarget) => {
      started.push(t.id)
      running += 1
      peak = Math.max(peak, running)
      return new Promise<DiskUsageMeasurement>((resolve) =>
        release.push(() => {
          running -= 1
          resolve(numbers(1))
        }),
      )
    }

    for (const id of ids) expect(projectDiskUsage(target(id), { measure }).measuring).toBe(true)
    await flush()
    expect(started).toEqual(ids.slice(0, 2))

    // Finishing one lets exactly the next in line start, in the order asked.
    release[0]?.()
    await flush()
    expect(started).toEqual(ids.slice(0, 3))
    expect(projectDiskUsage(target(ids[4]), { measure: unexpected }).measuring).toBe(true)

    for (let i = 1; i < ids.length; i += 1) {
      release[i]?.()
      await flush()
    }
    expect(started).toEqual(ids)
    expect(peak).toBe(2)
    for (const id of ids) {
      expect(projectDiskUsage(target(id), { measure: unexpected })).toMatchObject({
        measuring: false,
        totalBytes: 3,
      })
    }
  })

  test('a failed measurement frees its slot for the queue', async () => {
    const ids = [ID_A, ID_B, '33333333-3333-4333-8333-333333333333']
    const { measure, started, pending } = deferredMeasure()
    for (const id of ids) projectDiskUsage(target(id), { measure })
    await flush()
    expect(started).toHaveLength(2)
    pending[0]?.reject(new Error('boom'))
    await flush()
    expect(started).toHaveLength(3)
  })

  // --- project status: what setup does to the folder a TTL cannot see ------------

  test.each(['pending', 'cloning'] as const)(
    'a %s project is not measured on GET or on refresh, and reports nothing known',
    async (status) => {
      const { measure, started } = deferredMeasure()
      const expected = {
        projectId: ID_A,
        totalBytes: null,
        repoBytes: null,
        worktreesBytes: null,
        measuredAt: null,
        measuring: false,
        error: null,
      }
      expect(projectDiskUsage(target(ID_A, 'clone', status), { measure })).toEqual(expected)
      expect(projectDiskUsage(target(ID_A, 'clone', status), { measure, force: true })).toEqual(
        expected,
      )
      await flush()
      expect(started).toHaveLength(0)

      // Not even after the failure TTL, or the success TTL: nothing is ever
      // "stale" about an entry that does not exist.
      setSystemTime(new Date(Date.now() + DISK_USAGE_TTL_MS + 1))
      expect(projectDiskUsage(target(ID_A, 'clone', status), { measure })).toEqual(expected)
      await flush()
      expect(started).toHaveLength(0)
    },
  )

  test('a project being set up gets the cache as it is, with no error from another status', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'failed'), { measure })
    await flush()
    pending[0]?.reject(new DiskUsageFailure('Project folder not found'))
    await flush()

    // `failed` -> retry -> `pending`: the old failure is not this status's.
    const retrying = projectDiskUsage(target(ID_A, 'clone', 'pending'), { measure, force: true })
    expect(retrying).toMatchObject({ totalBytes: null, measuring: false, error: null })
    await flush()
    expect(started).toHaveLength(1)
  })

  test('a project that goes back to pending keeps its old numbers and starts no measurement', async () => {
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A), { measure })
    await flush()
    pending[0]?.resolve(numbers(100))
    await flush()

    const retrying = projectDiskUsage(target(ID_A, 'clone', 'pending'), { measure, force: true })
    expect(retrying).toMatchObject({
      totalBytes: 300,
      repoBytes: 100,
      measuring: false,
      error: null,
    })
    await flush()
    expect(started).toHaveLength(1)
  })

  test('measuring still reports a measurement that was already running when setup began', async () => {
    const { measure, started } = deferredMeasure()
    projectDiskUsage(target(ID_A), { measure })
    await flush()

    const usage = projectDiskUsage(target(ID_A, 'clone', 'cloning'), { measure, force: true })
    expect(usage.measuring).toBe(true)
    await flush()
    expect(started).toHaveLength(1)
  })

  test('an entry recorded under needs_manual, error and all, is re-measured on the first ready call', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'needs_manual'), { measure })
    await flush()
    pending[0]?.reject(new DiskUsageFailure('Project folder not found'))
    await flush()
    // Still the same status: the error is shown, and 30s has not passed.
    expect(projectDiskUsage(target(ID_A, 'clone', 'needs_manual'), { measure })).toMatchObject({
      error: 'Project folder not found',
      measuring: false,
    })
    expect(started).toHaveLength(1)

    // The operator fixed it by hand and retried; setup finished a second later.
    setSystemTime(new Date(Date.now() + 1000))
    const ready = projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })
    expect(ready).toEqual({
      projectId: ID_A,
      totalBytes: null,
      repoBytes: null,
      worktreesBytes: null,
      measuredAt: null,
      measuring: true,
      error: null,
    })
    await flush()
    expect(started).toHaveLength(2)

    pending[1]?.resolve(numbers(10))
    await flush()
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure: unexpected })).toMatchObject(
      {
        totalBytes: 30,
        measuring: false,
        error: null,
      },
    )
  })

  test('numbers taken under another status are served, flagged measuring, until the re-measure lands', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'failed'), { measure })
    await flush()
    pending[0]?.resolve(numbers(10)) // a half-cloned tree
    await flush()

    const ready = projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })
    expect(ready).toMatchObject({
      totalBytes: 30,
      measuredAt: '2026-03-04T10:00:00.000Z',
      measuring: true,
      error: null,
    })
    await flush()
    expect(started).toHaveLength(2)

    pending[1]?.resolve(numbers(500))
    await flush()
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure: unexpected })).toMatchObject(
      {
        totalBytes: 1500,
        measuring: false,
      },
    )
  })

  test('ready then ready within the TTL does not measure again', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })
    await flush()
    pending[0]?.resolve(numbers(1))
    await flush()

    setSystemTime(new Date(Date.now() + DISK_USAGE_TTL_MS - 1))
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })).toMatchObject({
      totalBytes: 3,
      measuring: false,
    })
    await flush()
    expect(started).toHaveLength(1)
  })

  test('ready then ready within the failure TTL keeps the error and does not measure again', async () => {
    setSystemTime(new Date('2026-03-04T10:00:00.000Z'))
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })
    await flush()
    pending[0]?.reject(new DiskUsageFailure('Could not read the folder size: du: boom'))
    await flush()

    setSystemTime(new Date(Date.now() + DISK_USAGE_FAILURE_TTL_MS - 1))
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })).toMatchObject({
      error: 'Could not read the folder size: du: boom',
      measuring: false,
    })
    await flush()
    expect(started).toHaveLength(1)
  })

  test('a status change while the old-status measurement runs: joined, then re-measured at once', async () => {
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(ID_A, 'clone', 'needs_manual'), { measure })
    await flush()

    // Ready now, but the measurement in flight was scheduled under needs_manual.
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure }).measuring).toBe(true)
    await flush()
    expect(started).toHaveLength(1) // joined, not doubled

    pending[0]?.resolve(numbers(1))
    await flush()
    // Its result does not pass for a ready project's: the very next call
    // measures again rather than serving it for five minutes.
    expect(projectDiskUsage(target(ID_A, 'clone', 'ready'), { measure })).toMatchObject({
      totalBytes: 3,
      measuring: true,
      error: null,
    })
    await flush()
    expect(started).toHaveLength(2)
  })

  test('forgetting a project drops its entry', async () => {
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    pending[0]?.resolve(numbers(1))
    await flush()

    forgetProjectDiskUsage(ID_A)
    // Back to "never measured": the next call has to measure again.
    expect(projectDiskUsage(target(), { measure })).toMatchObject({
      totalBytes: null,
      measuring: true,
    })
    await flush()
    expect(started).toHaveLength(2)
  })

  test('a measurement that lands after its project was forgotten is discarded', async () => {
    const { measure, started, pending } = deferredMeasure()
    projectDiskUsage(target(), { measure })
    await flush()
    forgetProjectDiskUsage(ID_A)
    pending[0]?.resolve(numbers(1))
    await flush()

    // Had the late result been cached, this would be a fresh hit with numbers.
    expect(projectDiskUsage(target(), { measure })).toMatchObject({
      totalBytes: null,
      measuring: true,
    })
    await flush()
    expect(started).toHaveLength(2)
  })

  test('a measurement still queued when its project is forgotten never runs', async () => {
    const ids = [ID_A, ID_B, '33333333-3333-4333-8333-333333333333']
    const { measure, started, pending } = deferredMeasure()
    for (const id of ids) projectDiskUsage(target(id), { measure })
    await flush()
    expect(started).toHaveLength(2)

    forgetProjectDiskUsage(ids[2] ?? '')
    pending[0]?.resolve(numbers(1))
    pending[1]?.resolve(numbers(1))
    await flush()
    expect(started.map((t) => t.id)).toEqual([ID_A, ID_B])
  })
})
