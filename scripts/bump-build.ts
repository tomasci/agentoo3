#!/usr/bin/env bun
// Increment the build number, then write the resulting version everywhere it is
// read from.
//
// Run from the pre-commit hook, so every commit carries a distinct version and
// the number in the status bar actually moves. `build` never resets: bumping
// major or minor by hand leaves it alone, which is what gives 0.9.375 followed
// later by 1.2.1899.
//
// version.json is the single source of truth. The two package.json files get the
// composed string as well, because that is where tooling looks for a version and
// having them disagree with the running app is worse than the duplication.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const VERSION_FILE = join(ROOT, 'version.json')
const MANIFESTS = [join(ROOT, 'backend/package.json'), join(ROOT, 'frontend/package.json')]

interface Version {
  major: number
  minor: number
  build: number
}

function assertVersion(value: unknown): Version {
  const v = value as Partial<Version>
  for (const key of ['major', 'minor', 'build'] as const) {
    if (typeof v[key] !== 'number' || !Number.isInteger(v[key]) || (v[key] as number) < 0) {
      throw new Error(`version.json: "${key}" must be a non-negative integer`)
    }
  }
  return v as Version
}

const version = assertVersion(JSON.parse(await readFile(VERSION_FILE, 'utf8')))
version.build += 1
const composed = `${version.major}.${version.minor}.${version.build}`

await writeFile(VERSION_FILE, `${JSON.stringify(version, null, 2)}\n`)

for (const manifest of MANIFESTS) {
  const text = await readFile(manifest, 'utf8')
  // Replace only the first top-level "version", by targeted edit rather than
  // parse-and-restringify: a dependency could be named "version", and rewriting
  // the whole file would reformat it on every commit.
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${composed}"`)
  if (next === text) throw new Error(`${manifest}: no top-level "version" field to update`)
  await writeFile(manifest, next)
}

// Staged here rather than by the hook runner, so the files land in the commit
// that produced them.
const staged = Bun.spawnSync(['git', 'add', '--', VERSION_FILE, ...MANIFESTS], { cwd: ROOT })
if (staged.exitCode !== 0) {
  throw new Error(`git add failed: ${new TextDecoder().decode(staged.stderr)}`)
}

console.log(`version ${composed}`)
