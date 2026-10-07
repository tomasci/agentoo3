// readRepoIdentity / configureRepoIdentity (src/lib/git.ts) plus the zod shape
// check at the HTTP boundary (gitIdentityInputSchema, features/projects/schema.ts)
// — modelled on git-ssh.test.ts, which already proves the sibling feature
// (core.sshCommand) actually reaches a worktree's own, unmediated git
// commands; this file proves the same thing for user.name/user.email.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { addWorktree, configureRepoIdentity, git, isRepoRoot, readRepoIdentity, withRepoLock } =
  await import('../src/lib/git')
const { gitIdentityInputSchema } = await import('../src/features/projects/schema')

let root: string
let globalConfigPath: string
let previousGitConfigGlobal: string | undefined

/**
 * A git command with nothing supplied to it beyond PATH and a global config
 * pointed at this file's own scratch directory: no ambient GIT_SSH_COMMAND,
 * no -c flags, no real home directory. This is the shape of the commands a
 * worktree's own agent — or a human over ssh — runs, and is why "the repo's
 * own config, with no flags added by us" is the thing worth proving rather
 * than a `-c user.name=...` commit, which would pass regardless of whether
 * this feature does anything at all.
 */
function bare(args: string[], cwd: string) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: globalConfigPath },
  })
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
  }
}

async function freshRepo(name: string): Promise<string> {
  const repo = join(root, name)
  await git(['init', '-q', '-b', 'main', repo])
  return repo
}

beforeAll(async () => {
  previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
  root = await mkdtemp(join(tmpdir(), 'agentoo-git-identity-'))
  globalConfigPath = join(root, 'global-gitconfig')
  // Isolates every git() call this file makes — and every `bare` one — from
  // whatever ~/.gitconfig happens to exist on the machine actually running
  // this suite. Without this, "local reads back null" and "effective falls
  // back to global" are both at the mercy of the runner's own config, which
  // is exactly the kind of flake this repo's own tests elsewhere go out of
  // their way to avoid (see setup-env.ts's own header for the same principle
  // applied to REDIS_URL).
  process.env.GIT_CONFIG_GLOBAL = globalConfigPath
})

afterAll(async () => {
  if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal
  await rm(root, { recursive: true, force: true })
})

test('a worktree picks up an identity set on the repo, with no -c flags at all', async () => {
  const repo = await freshRepo('repo-commit')

  const set = await configureRepoIdentity(repo, { name: 'Ada Lovelace', email: 'ada@example.com' })
  expect(set.ok).toBe(true)

  await writeFile(join(repo, 'a.txt'), 'hello\n')
  bare(['add', '-A'], repo)
  // No -c user.name/user.email, and HOME points nowhere readable — if this
  // succeeds at all, it is because the identity came from the repo's own
  // config, which is the entire point of configureRepoIdentity.
  expect(bare(['commit', '-qm', 'first'], repo).code).toBe(0)

  const worktree = join(root, 'wt-commit')
  expect((await addWorktree(repo, worktree, 'agentoo/s-identity')).ok).toBe(true)

  await writeFile(join(worktree, 'b.txt'), 'world\n')
  bare(['add', '-A'], worktree)
  expect(bare(['commit', '-qm', 'second'], worktree).code).toBe(0)

  const shown = bare(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], worktree).out
  expect(shown).toBe('Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>')
})

test('a hand-edited identity (git config user.name, no app involved) reads back as local', async () => {
  const repo = await freshRepo('repo-handwritten')

  expect(bare(['config', 'user.name', 'Hand Written'], repo).code).toBe(0)
  expect(bare(['config', 'user.email', 'hand@example.com'], repo).code).toBe(0)

  const state = await readRepoIdentity(repo)
  expect(state.local).toEqual({ name: 'Hand Written', email: 'hand@example.com' })
})

test('a global-only identity surfaces in effective, with local staying null', async () => {
  const repo = await freshRepo('repo-global-only')

  expect(bare(['config', '--global', 'user.name', 'Global Person'], repo).code).toBe(0)
  expect(bare(['config', '--global', 'user.email', 'global@example.com'], repo).code).toBe(0)

  try {
    const state = await readRepoIdentity(repo)
    expect(state.local).toEqual({ name: null, email: null })
    expect(state.effective).toEqual({ name: 'Global Person', email: 'global@example.com' })
  } finally {
    // Every later test in this file reads `effective` against the same
    // shared GIT_CONFIG_GLOBAL file, so this has to clean up after itself
    // rather than leaking "Global Person" into assertions that assume no
    // identity exists anywhere.
    bare(['config', '--global', '--unset-all', 'user.name'], repo)
    bare(['config', '--global', '--unset-all', 'user.email'], repo)
  }
})

test('clearing an identity is ok, and clearing an already-clear one is too', async () => {
  const repo = await freshRepo('repo-clear-twice')

  expect((await configureRepoIdentity(repo, { name: 'Temp', email: 'temp@example.com' })).ok).toBe(
    true,
  )

  const first = await configureRepoIdentity(repo, null)
  expect(first.ok).toBe(true)
  expect((await readRepoIdentity(repo)).local).toEqual({ name: null, email: null })

  // git exits 5 for "nothing to unset", which is the normal state of a
  // project nobody has (re-)configured and must not read as a failure —
  // mirroring configureRepoSsh's own exit-5 handling.
  const second = await configureRepoIdentity(repo, null)
  expect(second.ok).toBe(true)
  expect(second.exitCode).toBe(5)
})

test('replace-all collapses a hand-edited, multi-valued key back to one', async () => {
  const repo = await freshRepo('repo-multivalue')

  bare(['config', '--add', 'user.name', 'First'], repo)
  bare(['config', '--add', 'user.name', 'Second'], repo)
  expect(bare(['config', '--get-all', 'user.name'], repo).out.split('\n')).toEqual([
    'First',
    'Second',
  ])

  const result = await configureRepoIdentity(repo, {
    name: 'Collapsed',
    email: 'collapsed@example.com',
  })
  expect(result.ok).toBe(true)
  expect(bare(['config', '--get-all', 'user.name'], repo).out).toBe('Collapsed')
})

describe('isRepoRoot', () => {
  test('is false for a path that does not exist', async () => {
    expect(await isRepoRoot(join(root, 'never-created'))).toBe(false)
  })

  test('is false for a symlink whose target was removed', async () => {
    const target = join(root, 'dangling-target')
    const link = join(root, 'dangling-link')
    await mkdir(target, { recursive: true })
    await symlink(target, link, 'dir')
    await rm(target, { recursive: true, force: true })
    expect(await isRepoRoot(link)).toBe(false)
  })

  test('is false for a plain directory that only sits inside an outer repo', async () => {
    // The production shape this exists for: PROJECTS_DIR living inside
    // agentoo's own checkout, with a project's repo/ turning out not to be a
    // git repository at all. `isGitRepo` (`--is-inside-work-tree`) would
    // answer true here since `inner` is, in fact, inside `outer`'s work tree
    // — `isRepoRoot` must not.
    const outer = join(root, 'outer-enclosing')
    const inner = join(outer, 'not-a-repo')
    await git(['init', '-q', '-b', 'main', outer])
    await mkdir(inner, { recursive: true })
    expect(await isRepoRoot(inner)).toBe(false)
    // The outer repo itself is, of course, still its own root.
    expect(await isRepoRoot(outer)).toBe(true)
  })

  test('is true for a symlink to a real repo root', async () => {
    const target = await freshRepo('symlink-target')
    const link = join(root, 'symlink-to-root')
    await symlink(target, link, 'dir')
    expect(await isRepoRoot(link)).toBe(true)
  })

  test('is false for a subdirectory of a repo, not just the repo itself', async () => {
    const repo = await freshRepo('repo-with-subdir')
    const sub = join(repo, 'sub')
    await mkdir(sub, { recursive: true })
    expect(await isRepoRoot(repo)).toBe(true)
    expect(await isRepoRoot(sub)).toBe(false)
  })
})

describe('withRepoLock', () => {
  test('serializes concurrent identity writes so name and email never mix between writers', async () => {
    const repo = await freshRepo('repo-concurrent-identity')
    const writers = [
      { name: 'Alice A', email: 'alice@example.com' },
      { name: 'Bob B', email: 'bob@example.com' },
    ]

    // 50 calls, alternating writers, all fired at once — the exact shape of
    // the race that mixed `Bob B|alice@example.com` in production: each
    // writer's own name-then-email pair is two separate git invocations with
    // a real gap between them (a subprocess spawn apiece), so without the
    // lock serializing the whole critical section, one call's email write
    // can land in between another call's name and email writes.
    const calls = Array.from({ length: 50 }, (_, i) => writers[i % 2])
    await Promise.all(
      calls.map((identity) =>
        withRepoLock(repo, async () => {
          const result = await configureRepoIdentity(repo, identity)
          expect(result.ok).toBe(true)
          // Read back inside the same lock this call held for its write —
          // if any other call's write had landed in between this call's own
          // name and email writes, this would see a mixed pair instead of
          // its own.
          const state = await readRepoIdentity(repo)
          expect(state.local).toEqual(identity)
        }),
      ),
    )

    // Whoever wrote last, the file must still hold one writer's pair, never
    // a mix of the two.
    const final = await readRepoIdentity(repo)
    expect([writers[0], writers[1]]).toContainEqual(final.local)
  })
})

describe('gitIdentityInputSchema', () => {
  const valid = { name: 'Ada Lovelace', email: 'ada@example.com' }

  test('accepts a normal name and email', () => {
    expect(gitIdentityInputSchema.safeParse(valid).success).toBe(true)
  })

  test('accepts a GitHub noreply email', () => {
    const result = gitIdentityInputSchema.safeParse({
      ...valid,
      email: '123456+someuser@users.noreply.github.com',
    })
    expect(result.success).toBe(true)
  })

  test('trims surrounding whitespace on both fields', () => {
    const result = gitIdentityInputSchema.parse({
      name: '  Ada Lovelace  ',
      email: '  ada@example.com  ',
    })
    expect(result).toEqual(valid)
  })

  test('rejects an empty (or whitespace-only) name', () => {
    expect(gitIdentityInputSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false)
  })

  test('rejects a name over 200 characters', () => {
    expect(gitIdentityInputSchema.safeParse({ ...valid, name: 'a'.repeat(201) }).success).toBe(
      false,
    )
  })

  test('rejects an email over 254 characters', () => {
    const long = `${'a'.repeat(250)}@example.com`
    expect(gitIdentityInputSchema.safeParse({ ...valid, email: long }).success).toBe(false)
  })

  test('rejects an email with no "@"', () => {
    expect(gitIdentityInputSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(
      false,
    )
  })

  // Every bad character class below reaches `git config <key> <value>` as an
  // argv entry for *either* field, so each is checked on both.
  for (const [label, injected] of [
    ['a newline', 'x\ny'],
    ['a tab', 'x\ty'],
    ['a low control character (\\u0001)', 'x\u0001y'],
    ['DEL (\\u007f)', 'x\u007fy'],
    ['a "<" character', 'x<y'],
    ['a ">" character', 'x>y'],
  ] as const) {
    test(`rejects a name containing ${label}`, () => {
      expect(
        gitIdentityInputSchema.safeParse({ ...valid, name: `Ada${injected}Lovelace` }).success,
      ).toBe(false)
    })
    test(`rejects an email containing ${label}`, () => {
      expect(
        gitIdentityInputSchema.safeParse({ ...valid, email: `a${injected}b@example.com` }).success,
      ).toBe(false)
    })
  }

  test('rejects a name starting with "-"', () => {
    expect(gitIdentityInputSchema.safeParse({ ...valid, name: '-Ada Lovelace' }).success).toBe(
      false,
    )
  })

  test('rejects an email starting with "-"', () => {
    expect(gitIdentityInputSchema.safeParse({ ...valid, email: '-ada@example.com' }).success).toBe(
      false,
    )
  })
})
