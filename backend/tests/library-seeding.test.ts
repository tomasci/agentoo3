// scripts/68-setup-backend.sh's per-item library seeding, run for real.
//
// The seeding block is extracted verbatim from the shipped script (by line
// range, re-derived from its own markers so an edit above it cannot silently
// make this test exercise the wrong lines) and sourced into a harness that
// stubs only `as_root`, `log_ok` and `log_debug` — the three things that need
// privilege or a terminal. `set -Eeuo pipefail` matches scripts/lib/common.sh
// line 10, so a failure mode that depends on errexit behaves here as it does
// on a real box.
//
// What this pins down is the thing the change exists for: on a box that
// already has a non-empty library (i.e. every box that ever ran install.sh),
// a newly shipped skill directory reaches it *whole* — sibling files and all
// — while nothing the operator already had is touched.

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const REPO = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO, 'scripts', '68-setup-backend.sh')

/** The seeding block, located by its own first and last lines rather than by
 * hardcoded numbers. */
async function seedingBlock(): Promise<string> {
  const lines = (await Bun.file(SCRIPT).text()).split('\n')
  const start = lines.findIndex((l) => l === 'seeded=0')
  const marker = lines.findIndex((l, i) => i > start && l.includes('log_debug "Nothing new'))
  // The `fi` that closes `if [[ -d "$REPO_ROOT/library.example" ]]`.
  const closing = lines.indexOf('fi', marker)
  expect(start).toBeGreaterThan(-1)
  expect(marker).toBeGreaterThan(start)
  expect(closing).toBeGreaterThan(marker)
  const block = lines.slice(start, closing + 1).join('\n')
  // Fail loudly rather than silently exercising the wrong lines.
  expect(block).toContain('library.example/skills/')
  expect(block).toContain('as_root cp -a')
  return block
}

interface SeedResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runSeeding(libraryDir: string, repoRoot = REPO): Promise<SeedResult> {
  const block = await seedingBlock()
  const harness = [
    '#!/usr/bin/env bash',
    // scripts/lib/common.sh:10
    'set -Eeuo pipefail',
    'REPO_ROOT="$1"',
    'LIBRARY_DIR="$2"',
    'APP_USER="$(id -un)"',
    // The real as_root is `run ${_SUDO[@]+...} "$@"`; unprivileged here.
    'as_root() { "$@"; }',
    'log_ok()    { echo "OK: $*"; }',
    'log_debug() { echo "DEBUG: $*"; }',
    block,
    '',
  ].join('\n')

  const dir = await mkdtemp(join(tmpdir(), 'agentoo-seed-harness-'))
  const path = join(dir, 'harness.sh')
  await writeFile(path, harness, 'utf8')
  await chmod(path, 0o755)

  const proc = Bun.spawn(['bash', path, repoRoot, libraryDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  await rm(dir, { recursive: true, force: true })
  return { code, stdout, stderr }
}

async function emptyLibrary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-library-'))
  // Exactly what 68-setup-backend.sh:93 creates before seeding runs.
  for (const sub of ['agents', 'skills', 'prompts']) {
    await mkdir(join(dir, sub), { recursive: true })
  }
  return dir
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else out.push(rel)
    }
  }
  await walk(dir, '')
  return out
}

// --- the case the change exists for --------------------------------------

test('a pre-existing non-empty library still receives the new browser and docker skills, whole', async () => {
  const lib = await emptyLibrary()
  // An operator's box: an existing (edited) agent, an agent only they have,
  // and an existing skill directory they modified.
  const editedTester = '---\nrole: subagent\ndescription: OPERATOR EDITED\n---\n\nmine\n'
  await writeFile(join(lib, 'agents', 'tester.md'), editedTester, 'utf8')
  await writeFile(join(lib, 'agents', 'my-own.md'), '---\ndescription: mine\n---\n\nx\n', 'utf8')
  await mkdir(join(lib, 'skills', 'project-conventions'), { recursive: true })
  const editedSkill = '---\nname: project-conventions\ndescription: OPERATOR EDITED\n---\n\nmine\n'
  await writeFile(join(lib, 'skills', 'project-conventions', 'SKILL.md'), editedSkill, 'utf8')

  const run = await runSeeding(lib)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('new item(s) into')

  const files = await tree(lib)
  // The point of the whole change: the new skills arrive with their siblings,
  // not just SKILL.md.
  expect(files).toContain('skills/browser/SKILL.md')
  expect(files).toContain('skills/browser/mcp.json')
  expect(files).toContain('skills/docker/SKILL.md')
  expect(files).toContain('skills/docker/docker.ts')

  // Byte-identical to what ships.
  expect(await readFile(join(lib, 'skills', 'browser', 'mcp.json'), 'utf8')).toBe(
    await readFile(join(REPO, 'library.example', 'skills', 'browser', 'mcp.json'), 'utf8'),
  )
  expect(await readFile(join(lib, 'skills', 'docker', 'docker.ts'), 'utf8')).toBe(
    await readFile(join(REPO, 'library.example', 'skills', 'docker', 'docker.ts'), 'utf8'),
  )

  // Operator-modified items untouched, byte for byte.
  expect(await readFile(join(lib, 'agents', 'tester.md'), 'utf8')).toBe(editedTester)
  expect(await readFile(join(lib, 'skills', 'project-conventions', 'SKILL.md'), 'utf8')).toBe(
    editedSkill,
  )
  // And their own file survived.
  expect(files).toContain('agents/my-own.md')
})

test('an empty library gets every shipped item', async () => {
  const lib = await emptyLibrary()
  const run = await runSeeding(lib)
  expect(run.code).toBe(0)

  const got = await tree(lib)
  const want = await tree(join(REPO, 'library.example'))
  expect(got.sort()).toEqual(want.sort())
})

test('re-running seeds nothing and changes nothing (install.sh is re-run constantly)', async () => {
  const lib = await emptyLibrary()
  await runSeeding(lib)

  const before = new Map<string, string>()
  for (const rel of await tree(lib)) before.set(rel, await readFile(join(lib, rel), 'utf8'))

  const second = await runSeeding(lib)
  expect(second.code).toBe(0)
  expect(second.stdout).toContain('Nothing new in library.example to seed')

  const after = await tree(lib)
  expect(after.sort()).toEqual([...before.keys()].sort())
  for (const rel of after) expect(await readFile(join(lib, rel), 'utf8')).toBe(before.get(rel))
})

test('an existing skill directory blocks its own reseed, even when a sibling file is missing', async () => {
  // Documents the granularity honestly: "never overwrite" is per *item*, so a
  // half-populated skill directory an operator created is left half-populated
  // rather than repaired. Nothing else is blocked by it.
  const lib = await emptyLibrary()
  await mkdir(join(lib, 'skills', 'browser'), { recursive: true })
  await writeFile(join(lib, 'skills', 'browser', 'SKILL.md'), 'mine\n', 'utf8')

  const run = await runSeeding(lib)
  expect(run.code).toBe(0)

  const files = await tree(lib)
  expect(await readFile(join(lib, 'skills', 'browser', 'SKILL.md'), 'utf8')).toBe('mine\n')
  expect(files).not.toContain('skills/browser/mcp.json')
  // The docker skill beside it is unaffected.
  expect(files).toContain('skills/docker/docker.ts')
})

test('a symlinked skill directory an operator made is followed, not clobbered', async () => {
  const lib = await emptyLibrary()
  const elsewhere = await mkdtemp(join(tmpdir(), 'agentoo-skill-elsewhere-'))
  await writeFile(join(elsewhere, 'SKILL.md'), 'linked\n', 'utf8')
  await symlink(elsewhere, join(lib, 'skills', 'docker'))

  const run = await runSeeding(lib)
  expect(run.code).toBe(0)
  // The symlink target is untouched and no docker.ts was written through it.
  expect(await readdir(elsewhere)).toEqual(['SKILL.md'])
  expect(await readFile(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('linked\n')
})

test('a library.example that is not there at all is a no-op, not an error', async () => {
  const lib = await emptyLibrary()
  const bareRepo = await mkdtemp(join(tmpdir(), 'agentoo-no-example-'))
  const run = await runSeeding(lib, bareRepo)
  expect(run.code).toBe(0)
  expect(await tree(lib)).toEqual([])
})

test('an empty library.example subdirectory leaves the glob unexpanded without erroring', async () => {
  const lib = await emptyLibrary()
  const fakeRepo = await mkdtemp(join(tmpdir(), 'agentoo-empty-example-'))
  for (const sub of ['agents', 'skills', 'prompts']) {
    await mkdir(join(fakeRepo, 'library.example', sub), { recursive: true })
  }
  const run = await runSeeding(lib, fakeRepo)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.stdout).toContain('Nothing new in library.example to seed')
})
