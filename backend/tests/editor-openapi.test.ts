// `bun run openapi` (src/openapi.ts) renders the whole app to
// backend/openapi.json — the frontend's own client generator
// (scripts/gen-api-client.sh) reads that file, never the live server, so a
// route missing from it is a route the frontend can never call. A real
// subprocess with the exact `DATABASE_URL=unused REDIS_URL=unused` invocation
// backend/README.md documents, not a direct `createApp()` call in this shared
// test process: rendering the doc pulls in the queue module, which
// constructs real BullMQ Queue objects against REDIS_URL at import time (see
// editor-service.scenarios.ts's own header for the identical hazard) — the
// subprocess's own unreachable, but syntactically valid, REDIS_URL is what
// lets that construction succeed without ever actually dialling it.

import { expect, test } from 'bun:test'

const BACKEND_DIR = new URL('..', import.meta.url).pathname

test('GET /api/editors is present in the rendered OpenAPI document', async () => {
  const proc = Bun.spawn(['bun', 'run', 'openapi'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: 'unused', REDIS_URL: 'unused' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code, `bun run openapi failed:\n${stdout}\n${stderr}`).toBe(0)

  const spec = (await Bun.file(`${BACKEND_DIR}openapi.json`).json()) as {
    paths: Record<string, Record<string, unknown>>
  }
  expect(spec.paths).toHaveProperty('/api/editors')
  expect(spec.paths['/api/editors']).toHaveProperty('get')
})
