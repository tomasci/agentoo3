import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { git } = await import('../src/lib/git')

/**
 * What `git()` does with a pipe, rather than what it does with a repository.
 *
 * `git()` no longer reads stdout/stderr to EOF. It races each read against a
 * deadline derived from the process having exited, because over ssh the pipe's
 * write end is inherited by an `ssh` grandchild that Bun's spawn timeout does
 * not kill — waiting for EOF there waits forever. That bound is the fix; every
 * test here exists because the same bound, applied a few milliseconds early,
 * would truncate ordinary git output instead, and truncated output is silent.
 * Nothing in `GitResult` distinguishes "git printed 40 lines" from "git printed
 * 4000 and we stopped reading", so it has to be proven rather than assumed.
 */

let dir: string
/**
 * A TCP listener that accepts and then never sends a byte. This is the shape
 * that hangs: a connection that fails outright returns quickly on its own and
 * never reaches the bound being tested.
 */
let blackhole: ReturnType<typeof Bun.listen<undefined>>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-gitoutput-'))
  blackhole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } })
})

afterAll(async () => {
  blackhole.stop(true)
  await rm(dir, { recursive: true, force: true })
})

async function newRepo(label: string): Promise<string> {
  const repo = join(dir, label)
  await git(['init', '-q', '-b', 'main', repo], dir)
  return repo
}

/**
 * The variables that tell git which repository to act on, restated from
 * REPO_LOCATION_VARS in src/lib/git.ts because that list is not exported —
 * and should not be imported here even if it were, since the point of a direct
 * spawn in this file is to be independent of the module under test.
 */
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
] as const

/**
 * Spawn git with `cwd` as the only thing that selects a repository.
 *
 * Every direct spawn in this file goes through here, and any new one must:
 * `Bun.spawn(['git', ...], { cwd })` alone is not safe in this suite. Git
 * exports an absolute GIT_DIR into every hook process, `bun test` runs from
 * pre-push, and GIT_DIR outranks cwd — so a fixture that passes cwd and
 * inherits the ambient environment silently targets the repository being
 * pushed instead of its own temp directory.
 *
 * That is not theoretical and it is not the same thing as the hazard
 * git-env.test.ts covers. Commands routed through `git()` in src/lib/git.ts
 * are already scrubbed; these two were not, and under pre-push the
 * `git fast-import` below ran against this project's own checkout. It was
 * stopped only by git's refusal to move a branch to a tip that does not
 * contain the current one — "warning: not updating refs/heads/main" — which is
 * an accident of the fixture history, not a safety net. Written as one helper
 * so a third spawn site cannot reintroduce it by forgetting the env.
 */
function scrubbedGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of REPO_LOCATION_VARS) delete env[key]
  return env
}

function spawnGit(args: string[], cwd: string, stdin?: Uint8Array) {
  return Bun.spawn(['git', ...args], {
    cwd,
    env: scrubbedGitEnv(),
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/**
 * The same command, read the old unbounded way, as the thing to compare
 * against.
 *
 * Deliberately not the string the fixture was built from: that would only
 * prove `git()` agrees with this test's idea of the content. Reading the real
 * process output with `new Response(stream).text()` — which resolves on EOF and
 * nothing else — is the definition of "everything git wrote", and it is safe
 * here precisely because these commands are local and do terminate.
 */
async function referenceOutput(args: string[], cwd: string): Promise<string> {
  const proc = spawnGit(args, cwd)
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`fixture command failed: git ${args.join(' ')}`)
  return stdout
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/**
 * Byte-for-byte equality, reported in a way a human can act on.
 *
 * `expect(a).toBe(b)` on two multi-megabyte strings prints a diff nobody can
 * read, so the assertion is made on a digest and the mismatch is described
 * separately: where the two first diverge, and by how much, which is what
 * separates "truncated at a pipe boundary" from "corrupted in the middle".
 */
function expectSameBytes(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    let at = 0
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++
    throw new Error(
      `${label}: captured ${actual.length} chars, expected ${expected.length}; ` +
        `first difference at index ${at} ` +
        `(captured ${JSON.stringify(actual.slice(at, at + 40))}, ` +
        `expected ${JSON.stringify(expected.slice(at, at + 40))})`,
    )
  }
  expect(sha256(actual)).toBe(sha256(expected))
}

/**
 * Await `work`, but fail with the elapsed time instead of hanging the test
 * runner. A regression here is a promise that never settles, and without this
 * it surfaces as "test timed out" on whatever block bun happened to be in.
 */
async function withWatchdog<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  const stall = Symbol('stall')
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<typeof stall>((resolve) => {
    timer = setTimeout(() => resolve(stall), ms)
  })
  const outcome = await Promise.race([work, watchdog])
  clearTimeout(timer)
  if (outcome === stall) throw new Error(`${label} had not returned after ${ms}ms`)
  return outcome
}

/** A git alias whose body is a shell command, so a test can choose how git writes. */
const shellAlias = (name: string, body: string, args: string[] = []) => [
  '-c',
  `alias.${name}=!${body}`,
  name,
  ...args,
]

// --------------------------------------------------------------------------
// 1. Large stdout survives intact
// --------------------------------------------------------------------------

describe('a command with megabytes of stdout is captured whole', () => {
  let repo: string
  let reference: string

  beforeAll(async () => {
    repo = await newRepo('big-blob')
    // Multi-byte characters on purpose: the reader decodes incrementally with
    // `{ stream: true }`, so a chunk boundary landing mid-codepoint is a real
    // way to corrupt output that a pure-ASCII fixture would never catch.
    let body = ''
    for (let index = 0; index < 60_000; index++) {
      body += `line ${index} — ${'é中'.repeat(20)} ${'x'.repeat(20)}\n`
    }
    await writeFile(join(repo, 'big.txt'), body)
    await git(['add', '-A'], repo)
    await git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'big'], repo)

    reference = (await referenceOutput(['show', 'HEAD:big.txt'], repo)).trim()
  })

  test('the fixture is genuinely bigger than a pipe buffer', () => {
    // Without this, everything below could pass on a 4KB file that never comes
    // close to the case that would break.
    expect(Buffer.byteLength(reference)).toBeGreaterThan(4 * 1024 * 1024)
  })

  test('stdout matches the unbounded read of the same command, byte for byte', async () => {
    const result = await withWatchdog('git show', 30_000, git(['show', 'HEAD:big.txt'], repo))
    expect(result.ok).toBe(true)
    expectSameBytes(result.stdout, reference, 'git show HEAD:big.txt')
  })

  test('it matches on every one of 25 consecutive runs, not just a lucky one', async () => {
    // The failure mode being hunted is a race between the drain deadline and a
    // read still in flight. A single green run says nothing about it.
    const digests = new Set<string>()
    for (let run = 0; run < 25; run++) {
      const result = await withWatchdog(`git show (run ${run})`, 30_000, git(['show', 'HEAD:big.txt'], repo))
      if (result.stdout !== reference) {
        expectSameBytes(result.stdout, reference, `git show HEAD:big.txt (run ${run})`)
      }
      digests.add(sha256(result.stdout))
    }
    expect([...digests]).toEqual([sha256(reference)])
  }, 60_000)
})

// --------------------------------------------------------------------------
// 2. Large stdout produced a line at a time, over thousands of commits
// --------------------------------------------------------------------------

describe('git log over thousands of commits is captured whole', () => {
  let repo: string
  let reference: string
  const COMMITS = 4_000
  const logArgs = ['log', '--format=%H %ct %s', 'main']

  beforeAll(async () => {
    repo = await newRepo('many-commits')
    // fast-import rather than 4000 `git commit` calls: same history, under a
    // second, and the test stays worth running.
    let script = ''
    for (let index = 0; index < COMMITS; index++) {
      const message = `commit number ${index} ${'padding-'.repeat(6)}`
      script += 'commit refs/heads/main\n'
      script += `mark :${index + 1}\n`
      script += `committer t <t@e> ${1_700_000_000 + index} +0000\n`
      script += `data ${Buffer.byteLength(message)}\n${message}\n`
      if (index > 0) script += `from :${index}\n`
      script += `M 644 inline f.txt\ndata ${String(index).length}\n${index}\n`
    }
    script += 'done\n'

    const proc = spawnGit(
      ['fast-import', '--quiet', '--done'],
      repo,
      new TextEncoder().encode(script),
    )
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (exitCode !== 0) throw new Error(`fast-import failed: ${stderr}`)

    reference = (await referenceOutput(logArgs, repo)).trim()
  }, 60_000)

  test('the history really has the commits the log is meant to print', async () => {
    expect((await git(['rev-list', '--count', 'main'], repo)).stdout).toBe(String(COMMITS))
    expect(reference.split('\n')).toHaveLength(COMMITS)
  })

  test('every line of the log is present, on each of 30 runs', async () => {
    for (let run = 0; run < 30; run++) {
      const result = await withWatchdog(`git log (run ${run})`, 30_000, git(logArgs, repo))
      expect(result.ok).toBe(true)
      // Checked before the byte comparison because "how many commits went
      // missing" is the number that identifies a truncation at a glance.
      expect(result.stdout.split('\n')).toHaveLength(COMMITS)
      if (result.stdout !== reference) {
        expectSameBytes(result.stdout, reference, `git log (run ${run})`)
      }
    }
  }, 60_000)
})

// --------------------------------------------------------------------------
// 3. A chatty child on both pipes at once must not deadlock
// --------------------------------------------------------------------------

describe('a command that fills both pipe buffers', () => {
  let repo: string
  const SIZE = 1_000_000
  // Two writes big enough that neither fits in a pipe buffer. If either stream
  // were read only after the process exited, the process could never exit: it
  // would block writing into a full buffer nobody is draining.
  const body =
    `head -c ${SIZE} /dev/zero | tr '\\0' 'a'; ` + `head -c ${SIZE} /dev/zero | tr '\\0' 'b' >&2`

  beforeAll(async () => {
    repo = await newRepo('both-pipes')
  })

  test('returns instead of deadlocking, with both streams complete', async () => {
    const result = await withWatchdog(
      'git alias writing 1MB to each pipe',
      30_000,
      git(shellAlias('chatty', body), repo),
    )
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('a'.repeat(SIZE))
    expect(result.stderr).toBe('b'.repeat(SIZE))
  }, 40_000)

  test('the same holds when the two streams are interleaved in small writes', async () => {
    const interleaved = `for i in $(seq 1 2000); do printf 'out%s ' "$i"; printf 'err%s ' "$i" >&2; done`
    const result = await withWatchdog(
      'git alias interleaving both pipes',
      30_000,
      git(shellAlias('mixed', interleaved), repo),
    )
    expect(result.ok).toBe(true)
    expect(result.stdout.split(' ').filter(Boolean)).toHaveLength(2000)
    expect(result.stderr.split(' ').filter(Boolean)).toHaveLength(2000)
    expect(result.stdout.endsWith('out2000')).toBe(true)
    expect(result.stderr.endsWith('err2000')).toBe(true)
  }, 40_000)
})

describe('output small enough to sit entirely in the pipe buffer', () => {
  let repo: string

  beforeAll(async () => {
    repo = await newRepo('burst')
  })

  // The tightest case for a bound tied to process exit: the child never blocks
  // on a full buffer, so it can write everything and exit before the reader has
  // been scheduled once. Everything the caller is owed is then sitting unread in
  // a pipe belonging to a process that is already gone.
  for (const size of [1_000, 60_000, 65_000]) {
    test(`${size} bytes written in one burst arrive whole, on each of 20 runs`, async () => {
      const burst = `head -c ${size} /dev/zero | tr '\\0' 'q'`
      for (let run = 0; run < 20; run++) {
        const result = await withWatchdog(
          `git alias bursting ${size} bytes (run ${run})`,
          20_000,
          git(shellAlias('burst', burst), repo),
        )
        expect(result.ok).toBe(true)
        // Length rather than the whole string: a short read is the only failure
        // available here, and the number says how short.
        expect(result.stdout).toHaveLength(size)
      }
    }, 40_000)
  }
})

// --------------------------------------------------------------------------
// 4. A slow writer is not clipped by the drain grace
// --------------------------------------------------------------------------

describe('output that arrives in slow chunks', () => {
  let repo: string

  beforeAll(async () => {
    repo = await newRepo('slow-writer')
  })

  test('every chunk is captured, though they are spaced further apart than the grace window', async () => {
    // 6 chunks, 400ms apart: each gap is longer than the 300ms drain grace, so
    // a deadline that started before the process exited would keep at most the
    // first one.
    const drip = `for i in 1 2 3 4 5 6; do printf 'chunk%s\\n' "$i"; sleep 0.4; done`
    const started = Date.now()
    const result = await withWatchdog('git alias dripping output', 30_000, git(shellAlias('drip', drip), repo))
    const elapsed = Date.now() - started

    expect(result.ok).toBe(true)
    expect(result.stdout.split('\n')).toEqual([
      'chunk1',
      'chunk2',
      'chunk3',
      'chunk4',
      'chunk5',
      'chunk6',
    ])
    // Proves the writer really was slow, so the assertion above is about the
    // grace window rather than about six lines that all arrived at once.
    expect(elapsed).toBeGreaterThan(2_000)
  }, 40_000)

  test('a chunk larger than a pipe buffer arriving late is still whole', async () => {
    const late = `sleep 1; head -c 300000 /dev/zero | tr '\\0' 'z'`
    const result = await withWatchdog('git alias writing late', 30_000, git(shellAlias('late', late), repo))
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('z'.repeat(300_000))
  }, 40_000)
})

// --------------------------------------------------------------------------
// 5. No timeoutMs means no bound
// --------------------------------------------------------------------------

describe('a call with no timeoutMs', () => {
  let repo: string

  beforeAll(async () => {
    repo = await newRepo('unbounded')
  })

  test('is allowed to take as long as it takes', async () => {
    const started = Date.now()
    const result = await withWatchdog(
      'git alias sleeping 2s',
      30_000,
      git(shellAlias('slow', `sleep 2; printf 'finished\\n'`), repo),
    )
    const elapsed = Date.now() - started

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('finished')
    // Nothing may cut this short; the drain grace is 300ms and Bun's spawn
    // timeout is only set when timeoutMs is passed.
    expect(elapsed).toBeGreaterThan(1_900)
  }, 40_000)

  test('ordinary local commands still report what they always did', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(['add', '-A'], repo)
    await git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'only'], repo)

    const head = await git(['rev-parse', 'HEAD'], repo)
    expect(head.ok).toBe(true)
    expect(head.exitCode).toBe(0)
    expect(head.stdout).toMatch(/^[0-9a-f]{40}$/)
    expect(head.stderr).toBe('')

    const missing = await git(['rev-parse', '--verify', 'refs/heads/nope'], repo)
    expect(missing.ok).toBe(false)
    expect(missing.exitCode).toBeGreaterThan(0)
    expect(missing.stderr.length).toBeGreaterThan(0)
  })
})

// --------------------------------------------------------------------------
// 6. The bound tracks timeoutMs, rather than some other clock
// --------------------------------------------------------------------------

/**
 * "It came back quickly" is not the property. `ConnectTimeout=10` and ssh's own
 * give-up behaviour would also make a hang end eventually, and would look like
 * a fix on a single 500ms case. Running two very different timeouts and
 * checking the wall clock moves with them is what separates "bounded by
 * timeoutMs" from "bounded by something else that happens to be shorter than
 * the test".
 */
function boundTracksTimeout(label: string, url: (port: number) => string) {
  describe(`git() over ${label} stops when timeoutMs says so`, () => {
    const samples: { timeoutMs: number; elapsed: number; stderr: string; ok: boolean }[] = []

    beforeAll(async () => {
      for (const timeoutMs of [400, 2_000]) {
        const repo = await newRepo(`bound-${label.replace(/\W/g, '')}-${timeoutMs}`)
        await git(['remote', 'add', 'origin', url(blackhole.port)], repo)

        const started = Date.now()
        const result = await withWatchdog(
          `git fetch over ${label} with timeoutMs ${timeoutMs}`,
          15_000,
          git(['fetch', '--no-tags', 'origin', 'main'], repo, { timeoutMs }),
        )
        samples.push({
          timeoutMs,
          elapsed: Date.now() - started,
          stderr: result.stderr,
          ok: result.ok,
        })
      }
    }, 60_000)

    test('each call fails rather than hanging', () => {
      for (const sample of samples) expect(sample.ok).toBe(false)
    })

    test('each call returns within its own timeout plus the drain grace', () => {
      for (const sample of samples) {
        // Lower bound too: returning early would mean the timeout is not what
        // ended it, and something else is deciding when to give up.
        expect(sample.elapsed).toBeGreaterThanOrEqual(sample.timeoutMs - 50)
        expect(sample.elapsed).toBeLessThan(sample.timeoutMs + 1_500)
      }
    })

    test('a longer timeout really does take longer, so the bound is timeoutMs', () => {
      const [short, long] = samples
      if (!short || !long) throw new Error('expected two samples')
      expect(long.elapsed - short.elapsed).toBeGreaterThan(1_000)
    })

    test('the failure says why, instead of reading as an empty repository', () => {
      for (const sample of samples) {
        expect(sample.stderr.length).toBeGreaterThan(0)
        expect(sample.stderr).toContain(`${sample.timeoutMs}ms`)
      }
    })
  })
}

boundTracksTimeout('git://', (port) => `git://127.0.0.1:${port}/t.git`)
boundTracksTimeout('ssh://', (port) => `ssh://git@127.0.0.1:${port}/t.git`)

// --------------------------------------------------------------------------
// 7. The scenario the bound exists for, without needing a network at all
// --------------------------------------------------------------------------

test('a grandchild left holding the pipe does not hold up the caller', async () => {
  // This is the ssh hang in miniature: git exits, but a process it started
  // still has the write end of stdout open. Reading to EOF here waits for the
  // grandchild, not for git. The bound has to end the call on git's own exit.
  const repo = await newRepo('orphan-holder')
  const orphan = `( sleep 5; printf 'LATE\\n' ) & printf 'EARLY\\n'; exit 0`

  const started = Date.now()
  const result = await withWatchdog(
    'git alias leaving a grandchild on the pipe',
    20_000,
    git(shellAlias('orphan', orphan), repo),
  )
  const elapsed = Date.now() - started

  expect(result.ok).toBe(true)
  // git's own output is complete; only the detached writer's is not waited for.
  expect(result.stdout).toBe('EARLY')
  expect(elapsed).toBeLessThan(2_000)
}, 30_000)

// --------------------------------------------------------------------------
// 8. This file's own fixtures must stay inside their temp directory
// --------------------------------------------------------------------------

/**
 * A guard on the test file rather than on the code under test.
 *
 * git-env.test.ts proves `git()` scrubs the repository-location variables. It
 * cannot say anything about a fixture that bypasses `git()` and calls
 * `Bun.spawn` itself, which the two direct spawns above do — and one of them is
 * `fast-import`, which writes refs. Run from pre-push with GIT_DIR inherited
 * from the hook, that wrote into this project's own repository.
 *
 * The poisoned environment is passed to the child explicitly rather than by
 * assigning `process.env.GIT_DIR` here. That is not a stylistic choice: in Bun
 * 1.4, `Bun.spawn` with no `env` option hands the child the environment bun
 * itself started with and does *not* pick up later mutations of `process.env`.
 * A guard written the mutation way therefore passes whether or not the scrub is
 * present, which is exactly the sort of test that let this through in the first
 * place. Passing the environment in reproduces what the hook actually does.
 */
describe('a git process spawned directly by this file', () => {
  let fixture: string
  let victim: string
  let fixtureGitDir: string
  let victimGitDir: string
  /** What the hook hands us: an absolute GIT_DIR for the repository being pushed. */
  let poisoned: Record<string, string>

  beforeAll(async () => {
    fixture = await newRepo('env-fixture')
    victim = await newRepo('env-victim')
    // Resolved through `git()`, which is already scrubbed, so these are the
    // ground truth the assertions below compare against.
    fixtureGitDir = (await git(['rev-parse', '--absolute-git-dir'], fixture)).stdout
    victimGitDir = (await git(['rev-parse', '--absolute-git-dir'], victim)).stdout
    expect(fixtureGitDir).not.toBe(victimGitDir)
    poisoned = { ...scrubbedGitEnv(), GIT_DIR: victimGitDir }
  })

  async function gitDirSeenBy(env: Record<string, string>, cwd: string): Promise<string> {
    const proc = Bun.spawn(['git', 'rev-parse', '--absolute-git-dir'], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return stdout.trim()
  }

  test('the trap is real: an inherited GIT_DIR overrides cwd', async () => {
    // Without this the test below could pass on a git that never honoured
    // GIT_DIR, and would be guarding nothing.
    expect(await gitDirSeenBy(poisoned, fixture)).toBe(victimGitDir)
  })

  test('scrubbedGitEnv puts cwd back in charge', async () => {
    expect(await gitDirSeenBy(scrubbedGitEnv(poisoned), fixture)).toBe(fixtureGitDir)
  })

  // Spelled out rather than derived from REPO_LOCATION_VARS. A test that builds
  // its input by iterating the list it is checking shrinks in step with that
  // list: delete a variable from the constant and such a test still passes,
  // having quietly stopped covering it.
  const REDIRECTING_VARS = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ]

  test('every variable that can redirect git is removed, and nothing else is', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/someone' }
    const loaded: Record<string, string> = { ...base }
    for (const key of REDIRECTING_VARS) loaded[key] = `/somewhere/else/${key}`

    const scrubbed = scrubbedGitEnv(loaded)
    for (const key of REDIRECTING_VARS) expect(scrubbed[key]).toBeUndefined()
    // The scrub has to stay a scalpel: dropping PATH would break every spawn.
    expect(scrubbed).toMatchObject(base)
  })

  test('the scrub list matches src/lib/git.ts, which is where the set is defined', () => {
    expect([...REPO_LOCATION_VARS].sort()).toEqual(REDIRECTING_VARS)
  })

  test('spawnGit passes an environment at all, rather than inheriting silently', async () => {
    // The defect this file shipped with was an omitted `env` option, not a bad
    // one — and it cannot be caught by looking for GIT_DIR, because a plain
    // `Bun.spawn` inherits bun's *startup* environment, which has no GIT_DIR
    // outside a hook. A sentinel set at runtime does discriminate: it reaches
    // the child only if spawnGit spreads the current `process.env`, which is
    // the same code path that then deletes the redirecting variables from it.
    const SENTINEL = 'AGENTOO_GIT_FIXTURE_SENTINEL'
    const previous = process.env[SENTINEL]
    process.env[SENTINEL] = 'reached-the-child'
    try {
      const proc = spawnGit(shellAlias('echoenv', `printf '%s' "$${SENTINEL}"`), fixture)
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      expect(stdout).toBe('reached-the-child')
    } finally {
      if (previous === undefined) delete process.env[SENTINEL]
      else process.env[SENTINEL] = previous
    }
  })

  test('fast-import writes into the repo it was pointed at, not the ambient one', async () => {
    const refsBefore = await git(['for-each-ref', '--format=%(refname) %(objectname)'], victim)
    const message = 'imported while GIT_DIR named another repository'
    const script =
      'commit refs/heads/imported\n' +
      'committer t <t@e> 1700000000 +0000\n' +
      `data ${Buffer.byteLength(message)}\n${message}\n` +
      'M 644 inline i.txt\ndata 2\nhi\n' +
      'done\n'

    const proc = spawnGit(
      ['fast-import', '--quiet', '--done'],
      fixture,
      new TextEncoder().encode(script),
    )
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).toBe(0)
    // The exact symptom pre-push reported, and the only thing that stopped the
    // ref being moved for real.
    expect(stderr).not.toContain('not updating')

    expect((await git(['rev-parse', '--verify', 'refs/heads/imported'], fixture)).ok).toBe(true)
    expect((await git(['rev-parse', '--verify', 'refs/heads/imported'], victim)).ok).toBe(false)
    expect((await git(['for-each-ref', '--format=%(refname) %(objectname)'], victim)).stdout).toBe(
      refsBefore.stdout,
    )
  }, 30_000)
})
