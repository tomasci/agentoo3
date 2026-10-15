// See run-isolated.ts's own header for why this file only spawns
// projects-disk-usage-routes.scenarios.ts as its own subprocess rather than
// importing it directly into this shared `bun test tests/` process.

import { test } from 'bun:test'
import { runIsolatedScenarios } from './run-isolated'

test('projects-disk-usage-routes scenarios pass in their own isolated process', async () => {
  await runIsolatedScenarios('projects-disk-usage-routes.scenarios.ts')
}, 60_000)
