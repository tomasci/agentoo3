import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { addWorktree, fetchBranch, git, revParse } = await import('../src/lib/git')

/**
 * The pinned contract, restated rather than imported, so a module that is not
 * written yet fails each behaviour with a readable message instead of aborting
 * the file before bun has registered a single test.
 */
type BaseBranchPlan =
  | { ok: true; branch: string | null; startPoint: string | null; note?: string }
  | { ok: false; reason: string }
type PlanBaseBranch = (
  repoPath: string,
  requested: { override?: string; projectDefault: string | null },
) => Promise<BaseBranchPlan>

const planBaseBranch: PlanBaseBranch = await import('../src/features/sessions/base-branch')
  .then((module) => module.planBaseBranch)
  .catch((error: unknown) => () => {
    throw new Error(`src/features/sessions/base-branch.ts did not load: ${String(error)}`)
  })

let dir: string
/**
 * A TCP listener that accepts and never answers. `git://` then blocks waiting
 * for the ref advertisement, which is a fetch that hangs rather than one that
 * fails — different code paths, and only this one reaches the timeout. A local
 * socket keeps it deterministic: no unroutable address, and no dependence on
 * how this particular box drops packets.
 */
let blackhole: ReturnType<typeof Bun.listen<undefined>>

const commit = (cwd: string, message: string) =>
  git(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', message], cwd)

/** Commit real content. `git commit` with nothing staged exits non-zero and
 * leaves HEAD where it was, which silently defeats "these two shas differ". */
async function commitFile(cwd: string, file: string, body: string, message: string) {
  await writeFile(join(cwd, file), body)
  await git(['add', '-A'], cwd)
  const result = await commit(cwd, message)
  if (!result.ok) throw new Error(`fixture commit failed in ${cwd}: ${result.stderr}`)
}

const sha = async (repo: string, ref: string) => (await git(['rev-parse', ref], repo)).stdout

/** Narrows, and when it cannot, fails with the reason the plan gave. */
function planned(plan: BaseBranchPlan) {
  if (!plan.ok) throw new Error(`expected ok:true, got ${JSON.stringify(plan)}`)
  return plan
}

function refused(plan: BaseBranchPlan) {
  if (plan.ok) throw new Error(`expected ok:false, got ${JSON.stringify(plan)}`)
  return plan
}

/**
 * A bare origin that advertises `main`, plus a seed clone that can push to it.
 * `git init --bare` defaults HEAD to master and a clone of that lands on an
 * unborn branch, so without the symbolic-ref every assertion below would fail
 * for a reason unrelated to the feature.
 */
async function newOrigin(label: string) {
  const origin = join(dir, `${label}-origin.git`)
  const seed = join(dir, `${label}-seed`)
  await git(['init', '-q', '--bare', origin], dir)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin)
  await git(['init', '-q', '-b', 'main', seed], dir)
  await commitFile(seed, 'a.txt', 'one\n', 'first')
  await git(['remote', 'add', 'origin', origin], seed)
  await git(['push', '-q', 'origin', 'main'], seed)
  return { origin, seed }
}

/** Origin, seed and a fresh clone: the shape of a project's shared checkout. */
async function project(label: string) {
  const { origin, seed } = await newOrigin(label)
  const repo = join(dir, label)
  await git(['clone', '-q', origin, repo], dir)
  return { origin, seed, repo }
}

/** A repo with a commit and no remote at all: an adopted local-only project. */
async function localOnly(label: string) {
  const repo = join(dir, label)
  await git(['init', '-q', '-b', 'main', repo], dir)
  await commitFile(repo, 'a.txt', 'one\n', 'first')
  return repo
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-basebranch-'))
  blackhole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } })
})

afterAll(async () => {
  blackhole.stop(true)
  await rm(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// Precedence: override, then project default, then the repo's branch, then none
// --------------------------------------------------------------------------

describe('which branch the plan picks', () => {
  test('an override beats the project default', async () => {
    const { seed, repo } = await project('prec-override')
    await git(['push', '-q', 'origin', 'main:develop'], seed)
    await git(['fetch', '-q', 'origin'], repo)
    await git(['branch', 'develop', 'origin/develop'], repo)

    const plan = planned(
      await planBaseBranch(repo, { override: 'develop', projectDefault: 'main' }),
    )
    expect(plan.branch).toBe('develop')
  })

  test('the project default beats whatever the shared checkout happens to be on', async () => {
    const { seed, repo } = await project('prec-default')
    await git(['push', '-q', 'origin', 'main:develop'], seed)
    await git(['fetch', '-q', 'origin'], repo)
    // The bug this feature fixes: the checkout is parked on develop, so every
    // session cut from it started from develop rather than the project default.
    await git(['checkout', '-q', '-b', 'develop', 'origin/develop'], repo)

    const plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
    expect(plan.branch).toBe('main')
  })

  test("with no override and no default, the repo's current branch is used", async () => {
    const { repo } = await project('prec-current')
    const plan = planned(await planBaseBranch(repo, { projectDefault: null }))
    expect(plan.branch).toBe('main')
  })
})

describe('a detached HEAD is not a branch called HEAD', () => {
  let repo: string

  beforeAll(async () => {
    repo = (await project('detached')).repo
    await commitFile(repo, 'b.txt', 'two\n', 'second')
    await git(['checkout', '-q', '--detach', 'HEAD'], repo)
  })

  test('the trap is real: git reports the branch as the literal string HEAD', async () => {
    // This is what case 3 reads, and it exits 0, so nothing about the call
    // signals that there is no branch here.
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout).toBe('HEAD')
  })

  test('the plan does not come back with a branch named HEAD', async () => {
    const plan = planned(await planBaseBranch(repo, { projectDefault: null }))
    expect(plan.branch).not.toBe('HEAD')
  })

  test('it falls through to the orphan plan instead', async () => {
    const plan = planned(await planBaseBranch(repo, { projectDefault: null }))
    expect(plan).toMatchObject({ ok: true, branch: null, startPoint: null })
  })
})

test('a brand-new repo with no commits still gets an orphan plan', async () => {
  // `git worktree add -b <name> <path>` with no start point is the only form
  // that works on an unborn HEAD, and a freshly created project is exactly that.
  const empty = join(dir, 'unborn')
  await git(['init', '-q', '-b', 'main', empty], dir)

  const plan = planned(await planBaseBranch(empty, { projectDefault: null }))
  expect(plan.startPoint).toBeNull()
  expect(plan.branch).toBeNull()
})

// --------------------------------------------------------------------------
// Which ref the worktree is cut from
// --------------------------------------------------------------------------

describe('when the remote is ahead of the local branch', () => {
  let repo: string
  let remoteHead: string
  let plan: { branch: string | null; startPoint: string | null; note?: string }

  beforeAll(async () => {
    const made = await project('remote-ahead')
    repo = made.repo
    await commitFile(made.seed, 'b.txt', 'two\n', 'second')
    await git(['push', '-q', 'origin', 'main'], made.seed)
    remoteHead = await sha(made.seed, 'HEAD')

    plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
  })

  test('the start point is the remote-tracking ref', () => {
    expect(plan.startPoint).toBe('refs/remotes/origin/main')
  })

  test('the start point is the pushed commit, not the stale local one', async () => {
    // Without the fetch this is the sha the clone was taken at, which is the
    // whole complaint: sessions start from stale code.
    expect(await sha(repo, plan.startPoint ?? 'HEAD')).toBe(remoteHead)
    expect(await sha(repo, 'refs/heads/main')).not.toBe(remoteHead)
  })
})

describe('when the local branch is ahead of the remote', () => {
  let repo: string
  let localHead: string
  let remoteHead: string
  let plan: { branch: string | null; startPoint: string | null; note?: string }

  beforeAll(async () => {
    const made = await project('local-ahead')
    repo = made.repo
    remoteHead = await sha(repo, 'refs/heads/main')
    await commitFile(repo, 'local.txt', 'unpushed\n', 'local work, never pushed')
    localHead = await sha(repo, 'refs/heads/main')

    plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
  })

  test('the start point is the local ref', () => {
    expect(plan.startPoint).toBe('refs/heads/main')
  })

  test('the unpushed commits are not discarded', async () => {
    expect(await sha(repo, plan.startPoint ?? 'HEAD')).toBe(localHead)
    expect(localHead).not.toBe(remoteHead)
    // The remote tip is still an ancestor: local is ahead, not diverged.
    expect((await git(['merge-base', '--is-ancestor', remoteHead, localHead], repo)).ok).toBe(true)
  })
})

// --------------------------------------------------------------------------
// Degrade vs hard-fail
// --------------------------------------------------------------------------

describe('degrading when the remote cannot be reached', () => {
  test('an origin pointing at nothing still yields a plan, with a note', async () => {
    const { repo } = await project('unreachable')
    const local = await sha(repo, 'refs/heads/main')
    await git(['remote', 'set-url', 'origin', join(dir, 'does-not-exist.git')], repo)

    const plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
    expect(plan.startPoint).toBe('refs/heads/main')
    expect(await sha(repo, plan.startPoint ?? 'HEAD')).toBe(local)
    // A session that starts from slightly old code beats one that cannot start.
    expect(plan.note).toBeTruthy()
  })

  // ~20s, and the slowest thing in this file by an order of magnitude: it is
  // bounded by `fetchBranch`'s own default timeout, and `planBaseBranch` takes
  // no timeout argument to shorten it with. Worth the wall clock because it is
  // the only test that proves the fetch inside session creation is bounded at
  // all; give planBaseBranch a timeout parameter and this drops under a second.
  test('a fetch that hangs is abandoned and the plan still comes back, with a note', async () => {
    const { repo } = await project('hanging')
    const local = await sha(repo, 'refs/heads/main')
    await git(
      ['remote', 'set-url', 'origin', `git://127.0.0.1:${blackhole.port}/hanging.git`],
      repo,
    )

    const plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
    expect(plan.startPoint).toBe('refs/heads/main')
    expect(await sha(repo, plan.startPoint ?? 'HEAD')).toBe(local)
    expect(plan.note).toBeTruthy()
  }, 30_000)

  test('a branch that exists locally but not on the remote degrades with a note', async () => {
    const { repo } = await project('missing-on-remote')
    await git(['branch', 'feature/local-only'], repo)

    const plan = planned(await planBaseBranch(repo, { override: 'feature/local-only' }))
    expect(plan.branch).toBe('feature/local-only')
    expect(plan.startPoint).toBe('refs/heads/feature/local-only')
    expect(plan.note).toBeTruthy()
  })
})

test('a repo with no remote degrades silently, because local is the latest code', async () => {
  const repo = await localOnly('no-remote')
  const local = await sha(repo, 'refs/heads/main')

  const plan = planned(await planBaseBranch(repo, { projectDefault: 'main' }))
  expect(plan.startPoint).toBe('refs/heads/main')
  expect(await sha(repo, plan.startPoint ?? 'HEAD')).toBe(local)
  // Nothing has degraded here, so a warning would be noise on every session.
  expect(plan.note ?? null).toBeNull()
})

describe('refusing when the branch resolves to nothing', () => {
  test('an override naming a branch that exists nowhere is a hard failure', async () => {
    const { repo } = await project('override-missing')
    const plan = refused(await planBaseBranch(repo, { override: 'no-such-branch' }))
    expect(plan.reason.length).toBeGreaterThan(0)
  })

  test('a project default that has since been deleted is a hard failure', async () => {
    // Silently cutting from the current branch here hands the user a session
    // built on code they did not ask for and would not notice.
    const { repo } = await project('default-missing')
    const plan = refused(await planBaseBranch(repo, { projectDefault: 'release/deleted' }))
    expect(plan.reason.length).toBeGreaterThan(0)
  })
})

// --------------------------------------------------------------------------
// The shared checkout is a live working tree and must survive untouched
// --------------------------------------------------------------------------

/**
 * Run once with the checkout parked on the branch being planned, and once
 * parked elsewhere. The difference matters: git refuses to fetch into the
 * branch that is currently checked out, so the first case is protected by git
 * and only the second actually exercises our own restraint. A `git fetch
 * origin main:main` would sail through the first and quietly move the shared
 * checkout's `main` in the second.
 */
function sharedCheckoutSurvives(label: string, parkOn: string, planFor: string) {
  describe(`planning for ${planFor} does not disturb a shared checkout on ${parkOn}`, () => {
    let repo: string
    let before: { head: string; branch: string; ref: string; status: string; originRef: string }

    beforeAll(async () => {
      const made = await project(label)
      repo = made.repo
      if (parkOn !== 'main') {
        await git(['checkout', '-q', '-b', parkOn], repo)
        await commitFile(repo, `${parkOn}.txt`, 'parked\n', `work on ${parkOn}`)
      }

      // Another session's agent is mid-edit in this checkout.
      await writeFile(join(repo, 'scratch.txt'), 'work in progress\n')
      await writeFile(join(repo, 'a.txt'), 'edited\n')

      // Give the fetch something real to move.
      await commitFile(made.seed, 'b.txt', 'two\n', 'second')
      await git(['push', '-q', 'origin', 'main'], made.seed)

      before = {
        head: await sha(repo, 'HEAD'),
        branch: (await git(['symbolic-ref', '--short', 'HEAD'], repo)).stdout,
        ref: await sha(repo, `refs/heads/${planFor}`),
        status: (await git(['status', '--porcelain'], repo)).stdout,
        originRef: await sha(repo, `refs/remotes/origin/${planFor}`),
      }

      planned(await planBaseBranch(repo, { projectDefault: planFor }))
    })

    test('the fetch actually moved the remote-tracking ref', async () => {
      // Without this the assertions below would also pass on a plan that did
      // nothing at all.
      expect(await sha(repo, `refs/remotes/origin/${planFor}`)).not.toBe(before.originRef)
    })

    test(`refs/heads/${planFor} has not moved, even though origin/${planFor} did`, async () => {
      expect(await sha(repo, `refs/heads/${planFor}`)).toBe(before.ref)
    })

    test('HEAD and the checked-out branch are where they were', async () => {
      expect(await sha(repo, 'HEAD')).toBe(before.head)
      expect((await git(['symbolic-ref', '--short', 'HEAD'], repo)).stdout).toBe(before.branch)
    })

    test('the working tree keeps its dirt', async () => {
      expect((await git(['status', '--porcelain'], repo)).stdout).toBe(before.status)
      expect(await Bun.file(join(repo, 'scratch.txt')).text()).toBe('work in progress\n')
      expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('edited\n')
    })
  })
}

sharedCheckoutSurvives('untouched-same', 'main', 'main')
sharedCheckoutSurvives('untouched-other', 'develop', 'main')

// --------------------------------------------------------------------------
// git() must not hang on a remote that never answers
// --------------------------------------------------------------------------

/**
 * Run over both transports a project can be configured with. They are not the
 * same test: `git://` is spoken by the git process itself, while `ssh://` makes
 * git fork an `ssh` child that inherits the pipes `git()` is reading. A
 * timeout that only kills the direct child bounds the first and not the
 * second — and ssh is the transport this app actually provisions keys for.
 */
function timeoutIsBounded(label: string, url: (port: number) => string) {
  describe(`git() honours timeoutMs over ${label}`, () => {
    const NEVER_RETURNED = Symbol('watchdog')
    let outcome: Awaited<ReturnType<typeof git>> | typeof NEVER_RETURNED
    let elapsedMs: number

    beforeAll(async () => {
      const repo = await localOnly(`timeout-${label.replace(/\W/g, '')}`)
      await git(['remote', 'add', 'origin', url(blackhole.port)], repo)

      // The watchdog is part of the test. A git() that fails to bound the call
      // never returns here at all, and without a race that surfaces as "hook
      // timed out" for the whole block rather than as the assertion below.
      const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
      const watchdog = new Promise<typeof NEVER_RETURNED>((resolve) => {
        timer.id = setTimeout(() => resolve(NEVER_RETURNED), 6_000)
      })

      const started = Date.now()
      outcome = await Promise.race([
        git(['fetch', '--no-tags', 'origin', 'main'], repo, { timeoutMs: 500 }),
        watchdog,
      ])
      elapsedMs = Date.now() - started
      clearTimeout(timer.id)
    }, 20_000)

    /** Fails loudly rather than letting `outcome` be a symbol in an assertion. */
    function result() {
      if (outcome === NEVER_RETURNED) {
        throw new Error(`git() had not returned after ${elapsedMs}ms despite timeoutMs: 500`)
      }
      return outcome
    }

    test('a fetch that never answers gives up rather than blocking the worker', () => {
      expect(result().ok).toBe(false)
      // Generous on purpose: the property is "bounded", not "exactly 500ms".
      expect(elapsedMs).toBeLessThan(5_000)
    })

    test('the timed-out result says something, instead of failing silently', () => {
      // Bun hands back a SIGKILLed child with empty pipes, so `ok: false` alone
      // is indistinguishable from a command that legitimately printed nothing.
      // Some text has to reach the log, or a hanging remote reads as an empty
      // repository.
      expect(result().stderr.length).toBeGreaterThan(0)
    })
  })
}

timeoutIsBounded('git://', (port) => `git://127.0.0.1:${port}/t.git`)
timeoutIsBounded('ssh://', (port) => `ssh://git@127.0.0.1:${port}/t.git`)

// --------------------------------------------------------------------------
// The start point has to actually reach `git worktree add`
// --------------------------------------------------------------------------

test('addWorktree cuts from the start point, not from the shared checkout HEAD', async () => {
  const { repo } = await project('worktree-start')
  const mainSha = await sha(repo, 'refs/heads/main')
  // The shared checkout is parked on something else, which is the normal case.
  await git(['checkout', '-q', '-b', 'develop'], repo)
  await commitFile(repo, 'develop.txt', 'only on develop\n', 'develop only')
  const developSha = await sha(repo, 'HEAD')
  expect(developSha).not.toBe(mainSha)

  const worktree = join(dir, 'worktree-start-wt')
  const added = await addWorktree(repo, worktree, 'agentoo/s-startpoint', 'refs/heads/main')
  expect(added.ok).toBe(true)

  expect(await sha(worktree, 'HEAD')).toBe(mainSha)
  expect(await sha(worktree, 'HEAD')).not.toBe(developSha)
})

// --------------------------------------------------------------------------
// The two git helpers the plan is built on
// --------------------------------------------------------------------------

describe('fetchBranch', () => {
  test('brings the remote-tracking ref up to date', async () => {
    const { seed, repo } = await project('fetch-branch')
    const stale = await sha(repo, 'refs/remotes/origin/main')
    await commitFile(seed, 'b.txt', 'two\n', 'second')
    await git(['push', '-q', 'origin', 'main'], seed)

    const result = await fetchBranch(repo, 'origin', 'main')
    expect(result.ok).toBe(true)
    expect(await sha(repo, 'refs/remotes/origin/main')).toBe(await sha(seed, 'HEAD'))
    expect(await sha(repo, 'refs/remotes/origin/main')).not.toBe(stale)
  })

  test('fails, with something in stderr, when the remote has no such branch', async () => {
    const { repo } = await project('fetch-missing')
    const result = await fetchBranch(repo, 'origin', 'no-such-branch')
    expect(result.ok).toBe(false)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

describe('revParse', () => {
  test('resolves an existing ref to a full sha', async () => {
    const repo = await localOnly('revparse')
    const resolved = await revParse(repo, 'refs/heads/main')
    expect(resolved).toBe(await sha(repo, 'refs/heads/main'))
    expect(resolved).toMatch(/^[0-9a-f]{40}$/)
  })

  test('answers undefined for a ref that is not there, rather than throwing', async () => {
    const repo = await localOnly('revparse-missing')
    expect(await revParse(repo, 'refs/heads/nope')).toBeUndefined()
  })
})
