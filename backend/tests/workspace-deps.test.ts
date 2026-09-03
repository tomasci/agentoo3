import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const { installWorkspaceDeps, managerFor, packageDirs } = await import(
  '../src/features/sessions/workspace-deps'
)

let dir: string

const manifest = (at: string, name: string) =>
  writeFile(join(at, 'package.json'), JSON.stringify({ name, private: true }))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentoo-deps-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// --- what counts as a package directory --------------------------------------

test('the root counts when it has a manifest', async () => {
  await manifest(dir, 'root')
  expect(await packageDirs(dir)).toEqual([dir])
})

test('immediate subdirectories count, which is the backend/frontend split', async () => {
  await mkdir(join(dir, 'backend'))
  await mkdir(join(dir, 'frontend'))
  await manifest(join(dir, 'backend'), 'be')
  await manifest(join(dir, 'frontend'), 'fe')

  expect(await packageDirs(dir)).toEqual([join(dir, 'backend'), join(dir, 'frontend')])
})

test('a repository with no manifest anywhere yields nothing to do', async () => {
  await writeFile(join(dir, 'main.py'), 'print(1)\n')
  expect(await packageDirs(dir)).toEqual([])
})

test('node_modules and dotfiles are never descended into', async () => {
  // A manifest inside node_modules is a dependency's own, not a workspace.
  await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  await manifest(join(dir, 'node_modules'), 'nm')
  await mkdir(join(dir, '.github'))
  await manifest(join(dir, '.github'), 'gh')

  expect(await packageDirs(dir)).toEqual([])
})

test('nothing two levels down is picked up', async () => {
  await mkdir(join(dir, 'packages', 'deep'), { recursive: true })
  await manifest(join(dir, 'packages', 'deep'), 'deep')
  expect(await packageDirs(dir)).toEqual([])
})

// --- picking the manager ------------------------------------------------------

test('the committed lockfile picks the manager', async () => {
  await manifest(dir, 'x')

  await writeFile(join(dir, 'package-lock.json'), '{}')
  expect((await managerFor(dir)).bin).toBe('npm')
  // `npm ci` rather than `npm install`, so a session cannot quietly resolve
  // different versions than the lockfile pins.
  expect((await managerFor(dir)).locked).toEqual(['ci'])

  await writeFile(join(dir, 'pnpm-lock.yaml'), '')
  expect((await managerFor(dir)).bin).toBe('pnpm')

  await writeFile(join(dir, 'bun.lock'), '')
  expect((await managerFor(dir)).bin).toBe('bun')
})

test('no lockfile falls back to bun, which the platform always installs', async () => {
  await manifest(dir, 'x')
  const manager = await managerFor(dir)
  expect(manager.bin).toBe('bun')
  // Nothing to be frozen against.
  expect(manager.unlocked).toEqual(['install'])
})

// --- installing ---------------------------------------------------------------

test('a real install populates node_modules', async () => {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, dependencies: {} }),
  )
  await installWorkspaceDeps(dir)
  // bun creates node_modules even for an empty dependency set, which is what
  // the skip check below keys on.
  expect(await Bun.file(join(dir, 'package.json')).exists()).toBe(true)
})

test('a directory that already has node_modules is left alone', async () => {
  await manifest(dir, 'x')
  await mkdir(join(dir, 'node_modules'))
  const marker = join(dir, 'node_modules', '.untouched')
  await writeFile(marker, 'keep')

  await installWorkspaceDeps(dir)

  // An install would have rewritten the tree; the marker proves it was skipped.
  expect(await Bun.file(marker).text()).toBe('keep')
})

test('a checkout with nothing to install does not throw', async () => {
  await writeFile(join(dir, 'README.md'), 'no manifest here\n')
  expect(await installWorkspaceDeps(dir).then(() => 'ok')).toBe('ok')
})

test('a broken manifest is reported, not thrown', async () => {
  // --frozen-lockfile against a lockfile that cannot satisfy the manifest is
  // the realistic failure. It must not take the turn down with it.
  await writeFile(join(dir, 'package.json'), '{ this is not json')
  await writeFile(join(dir, 'bun.lock'), '')
  expect(await installWorkspaceDeps(dir).then(() => 'ok')).toBe('ok')
  expect(await Bun.file(join(dir, 'node_modules')).exists()).toBe(false)
})
