// probeEditorHealth/probeEditorHealthz (features/editor/container.ts) — the
// actual `/healthz` HTTP request and JSON parsing, against a REAL unix
// socket server (the same `Bun.serve({ unix })` discipline editor-proxy-http.
// scenarios.ts already uses for its own fake upstream), not a stubbed
// `fetch`. What each body shape maps to (service.ts's own `listRunningEditors`
// mapping from the resulting `{ answered, alive, lastHeartbeat }` to a
// `health` label) is covered instead in editor-running-editors.scenarios.ts —
// this file only owns the boundary: is code-server's own body actually parsed
// the way the design doc says it is.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import './setup-env'
import { probeEditorHealth, probeEditorHealthz } from '../src/features/editor/container'

const SOCKET_DIR = await mkdtemp(join(tmpdir(), 'ed-hz-'))
const SOCKET_PATH = join(SOCKET_DIR, 's.sock')

afterAll(async () => {
  await rm(SOCKET_DIR, { recursive: true, force: true })
})

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

function serve(handler: (req: Request) => Response): void {
  server = Bun.serve({ unix: SOCKET_PATH, fetch: handler })
}

test("an 'alive' body reports answered, alive: true, and the given lastHeartbeat", async () => {
  serve(() => Response.json({ status: 'alive', lastHeartbeat: 1_700_000_000_000 }))
  const probe = await probeEditorHealth(SOCKET_PATH, 1_000)
  expect(probe).toEqual({ answered: true, alive: true, lastHeartbeat: 1_700_000_000_000 })
  expect(await probeEditorHealthz(SOCKET_PATH, 1_000)).toBe(true)
})

test("an 'expired' body reports answered, alive: false", async () => {
  serve(() => Response.json({ status: 'expired', lastHeartbeat: 1_600_000_000_000 }))
  const probe = await probeEditorHealth(SOCKET_PATH, 1_000)
  expect(probe).toEqual({ answered: true, alive: false, lastHeartbeat: 1_600_000_000_000 })
  // probeEditorHealthz only ever asked "did it answer" — an idle-but-reachable
  // editor is still `running`, not `unresponsive` (see deriveEditorState).
  expect(await probeEditorHealthz(SOCKET_PATH, 1_000)).toBe(true)
})

test('a 200 with an unparseable body (invalid JSON) reports answered, alive: null', async () => {
  serve(() => new Response('not json', { headers: { 'content-type': 'application/json' } }))
  const probe = await probeEditorHealth(SOCKET_PATH, 1_000)
  expect(probe).toEqual({ answered: true, alive: null, lastHeartbeat: null })
  expect(await probeEditorHealthz(SOCKET_PATH, 1_000)).toBe(true)
})

test('a 200 with valid JSON in an unexpected shape reports answered, alive: null', async () => {
  serve(() => Response.json({ ok: true })) // no `status`/`lastHeartbeat` at all
  const probe = await probeEditorHealth(SOCKET_PATH, 1_000)
  expect(probe).toEqual({ answered: true, alive: null, lastHeartbeat: null })
})

test('a non-2xx response reports answered: false, regardless of its body', async () => {
  serve(() => Response.json({ status: 'alive', lastHeartbeat: 1 }, { status: 500 }))
  const probe = await probeEditorHealth(SOCKET_PATH, 1_000)
  expect(probe).toEqual({ answered: false, alive: null, lastHeartbeat: null })
  expect(await probeEditorHealthz(SOCKET_PATH, 1_000)).toBe(false)
})

test('no listener at all (socket file does not exist) reports answered: false, never throws', async () => {
  const probe = await probeEditorHealth(join(SOCKET_DIR, 'nobody-listens.sock'), 1_000)
  expect(probe).toEqual({ answered: false, alive: null, lastHeartbeat: null })
  expect(await probeEditorHealthz(join(SOCKET_DIR, 'nobody-listens.sock'), 1_000)).toBe(false)
})
