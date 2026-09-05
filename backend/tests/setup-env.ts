// Environment for the whole test run, not per file.
//
// `@/env` parses process.env once, at first import, and bun shares the module
// registry across test files — so whichever file happens to load first decides
// the configuration every other file then sees. Setting REDIS_URL inside a
// single test file looked like it worked only while that file happened to load
// first; adding one earlier in the alphabet silently pointed the event bus at a
// Redis that was not there, and six tests began timing out.
//
// Import this first, before anything that reaches `@/env`.

import { listen } from 'bun'

/**
 * A free port, obtained by binding 0 and reading back what the kernel assigned.
 *
 * This was hardcoded to 6399, which made two overlapping backend test runs
 * fight over one port — and they do overlap: `pre-push` runs the suite while a
 * developer, or another session pushing at the same time, may be running it
 * too. The loser cannot bind, and because that happens while the test file is
 * still loading it surfaces as a non-zero exit with `0 fail` and no failing
 * test named. Two of three pushes failed that way, which reads as an unrelated
 * flake rather than a port conflict.
 *
 * Reserved here rather than by the test that starts the server because
 * REDIS_URL has to be final before anything parses `@/env` — see the note
 * above. That leaves a short window between this probe closing and the fake
 * server binding, which is why startFakeRedis retries.
 */
function reserveFreePort(): number {
  const probe = listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/** The fake RESP server's port. Shared, because the parsed env is shared. */
export const FAKE_REDIS_PORT = reserveFreePort()

process.env.REDIS_URL = `redis://127.0.0.1:${FAKE_REDIS_PORT}`
process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/db'

// Deliberately a path that does not exist: it exercises the disk fallback in
// the system stats, which is the state of a freshly installed box.
export const MISSING_PROJECTS_DIR = '/nonexistent-agentoo-projects-dir'
process.env.PROJECTS_DIR = MISSING_PROJECTS_DIR

// A credential, so `hasClaudeCredential` is true and a turn under test gets as
// far as the SDK instead of stopping at the guard before it. Nothing here ever
// reaches Anthropic: the SDK is mocked wherever a turn is actually run.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-not-a-real-token'
