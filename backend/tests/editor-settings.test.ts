// seedEditorSettings (features/editor/settings.ts) — the file every editor
// start seeds `data/User/settings.json` from, whether that's the shipped
// config/editor-settings.json or an operator's EDITOR_SETTINGS_FILE
// override. Every case here calls the function directly with a plain
// override argument (never `mock.module('@/env.ts', ...)`): settings.ts
// deliberately takes that value as a parameter instead of reading it off
// `@/env` itself, precisely so a test can vary it without the whole-process
// mock hazard run-isolated.ts's own header describes.

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { seedEditorSettings } from '../src/features/editor/settings'

const OWNER = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const SETTINGS_PATH = (runtimeDir: string) => join(runtimeDir, 'data', 'User', 'settings.json')

test('with no override, the shipped defaults are written verbatim (2-space indent)', async () => {
  const runtimeDir = await tempDir('ed-settings-')

  const result = await seedEditorSettings(runtimeDir, OWNER, undefined)

  expect(result.applied).toBe(true)
  expect(result.label).toBe('config/editor-settings.json')
  const written = await readFile(SETTINGS_PATH(runtimeDir), 'utf8')
  expect(JSON.parse(written)).toEqual({
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  })
  expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`)
})

test('a pre-existing settings.json with different contents is overwritten, not merged', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const userDir = join(runtimeDir, 'data', 'User')
  await mkdir(userDir, { recursive: true })
  await writeFile(SETTINGS_PATH(runtimeDir), JSON.stringify({ 'editor.fontSize': 99, leftover: true }))

  const result = await seedEditorSettings(runtimeDir, OWNER, undefined)

  expect(result.applied).toBe(true)
  const written = JSON.parse(await readFile(SETTINGS_PATH(runtimeDir), 'utf8'))
  expect(written).toEqual({
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  })
  expect(written).not.toHaveProperty('leftover')
})

test('an EDITOR_SETTINGS_FILE override replaces the shipped file entirely', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const overrideDir = await tempDir('ed-settings-override-')
  const overridePath = join(overrideDir, 'my-defaults.json')
  await writeFile(overridePath, JSON.stringify({ 'editor.tabSize': 4 }))

  const result = await seedEditorSettings(runtimeDir, OWNER, overridePath)

  expect(result.applied).toBe(true)
  expect(result.label).toBe(overridePath)
  const written = JSON.parse(await readFile(SETTINGS_PATH(runtimeDir), 'utf8'))
  expect(written).toEqual({ 'editor.tabSize': 4 })
  expect(written).not.toHaveProperty('workbench.startupEditor')
})

test('directories and the settings file are created 0700/0600, mirroring prepareEditorRuntimeDir', async () => {
  const runtimeDir = await tempDir('ed-settings-')

  await seedEditorSettings(runtimeDir, OWNER, undefined)

  const dataStat = await stat(join(runtimeDir, 'data'))
  const userStat = await stat(join(runtimeDir, 'data', 'User'))
  const fileStat = await stat(SETTINGS_PATH(runtimeDir))
  expect(dataStat.mode & 0o777).toBe(0o700)
  expect(userStat.mode & 0o777).toBe(0o700)
  expect(fileStat.mode & 0o777).toBe(0o600)
})

test('0600 is re-asserted even when settings.json already existed with looser permissions', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const userDir = join(runtimeDir, 'data', 'User')
  await mkdir(userDir, { recursive: true })
  await writeFile(SETTINGS_PATH(runtimeDir), '{}')
  await chmod(SETTINGS_PATH(runtimeDir), 0o644)

  await seedEditorSettings(runtimeDir, OWNER, undefined)

  const fileStat = await stat(SETTINGS_PATH(runtimeDir))
  expect(fileStat.mode & 0o777).toBe(0o600)
})

test('a missing override file: the start would still succeed — applied false, no settings file written', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const overrideDir = await tempDir('ed-settings-override-')
  const missingPath = join(overrideDir, 'does-not-exist.json')

  const result = await seedEditorSettings(runtimeDir, OWNER, missingPath)

  expect(result.applied).toBe(false)
  expect(result.label).toBe(missingPath)
  expect(result.reason).toBeDefined()
  await expect(readFile(SETTINGS_PATH(runtimeDir), 'utf8')).rejects.toThrow()
})

test('invalid JSON in the override: applied false, reason names it, no settings file written', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const overrideDir = await tempDir('ed-settings-override-')
  const overridePath = join(overrideDir, 'broken.json')
  await writeFile(overridePath, '{ this is not json')

  const result = await seedEditorSettings(runtimeDir, OWNER, overridePath)

  expect(result.applied).toBe(false)
  expect(result.reason).toContain('invalid JSON')
  await expect(readFile(SETTINGS_PATH(runtimeDir), 'utf8')).rejects.toThrow()
})

test('a JSON array in the override: applied false, no settings file written', async () => {
  const runtimeDir = await tempDir('ed-settings-')
  const overrideDir = await tempDir('ed-settings-override-')
  const overridePath = join(overrideDir, 'array.json')
  await writeFile(overridePath, '["not", "an", "object"]')

  const result = await seedEditorSettings(runtimeDir, OWNER, overridePath)

  expect(result.applied).toBe(false)
  expect(result.reason).toContain('array')
  await expect(readFile(SETTINGS_PATH(runtimeDir), 'utf8')).rejects.toThrow()
})

test('the runtime dir for --user-data-dir is created even when the defaults are unusable', async () => {
  // code-server itself still needs `/run/agentoo-editor/data` to exist —
  // this must not depend on the defaults file being valid.
  const runtimeDir = await tempDir('ed-settings-')
  const overrideDir = await tempDir('ed-settings-override-')
  const overridePath = join(overrideDir, 'broken.json')
  await writeFile(overridePath, 'not json at all')

  const result = await seedEditorSettings(runtimeDir, OWNER, overridePath)

  expect(result.applied).toBe(false)
  const dataStat = await stat(join(runtimeDir, 'data', 'User'))
  expect(dataStat.isDirectory()).toBe(true)
})
