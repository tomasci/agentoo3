// config/editor-settings.json — the file every editor on every install seeds
// from by default (features/editor/settings.ts). Guards the repo's own
// shipped asset directly: someone editing it by hand (or a merge that
// mangles it) breaks every editor on every box on the next start, silently
// (settings.ts falls back to "no seeded settings" rather than failing the
// start — see editor-settings.test.ts), so this is the one test that would
// actually catch it.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const SHIPPED_PATH = join(import.meta.dir, '..', '..', 'config', 'editor-settings.json')

test('the shipped defaults file exists, parses, and contains exactly the three keys the design specifies', async () => {
  const raw = await readFile(SHIPPED_PATH, 'utf8')
  const parsed: unknown = JSON.parse(raw)

  expect(parsed).toEqual({
    'workbench.startupEditor': 'none',
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  })
  expect(Object.keys(parsed as object)).toHaveLength(3)
})
