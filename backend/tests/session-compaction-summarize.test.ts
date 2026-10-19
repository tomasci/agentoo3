// See run-isolated.ts's own header for why this file only spawns
// session-compaction-summarize.scenarios.ts as its own subprocess rather than
// importing it directly into this shared `bun test tests/` process: it replaces
// the SDK with mock.module, which would reach every other file that imports it.

import { test } from 'bun:test'
import { runIsolatedScenarios } from './run-isolated'

test('session compaction summarizer scenarios pass in their own isolated process', async () => {
  await runIsolatedScenarios('session-compaction-summarize.scenarios.ts')
}, 60_000)
