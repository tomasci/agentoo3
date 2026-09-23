// See run-isolated.ts's own header for why this file only spawns
// editor-reaper.scenarios.ts as its own subprocess rather than importing it
// directly into this shared `bun test tests/` process.

import { test } from 'bun:test'
import { runIsolatedScenarios } from './run-isolated'

test('editor-reaper scenarios pass in their own isolated process', async () => {
  await runIsolatedScenarios('editor-reaper.scenarios.ts')
}, 30_000)
