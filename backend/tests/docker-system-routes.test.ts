// See run-isolated.ts's own header for why this file only spawns
// docker-system-routes.scenarios.ts as its own subprocess rather than
// importing it directly into this shared `bun test tests/` process.

import { test } from 'bun:test'
import { runIsolatedScenarios } from './run-isolated'

test('docker-system-routes scenarios pass in their own isolated process', async () => {
  await runIsolatedScenarios('docker-system-routes.scenarios.ts')
}, 60_000)
