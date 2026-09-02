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

/** The fake RESP server's port. Shared, because the parsed env is shared. */
export const FAKE_REDIS_PORT = 6399

process.env.REDIS_URL = `redis://127.0.0.1:${FAKE_REDIS_PORT}`
process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/db'

// Deliberately a path that does not exist: it exercises the disk fallback in
// the system stats, which is the state of a freshly installed box.
export const MISSING_PROJECTS_DIR = '/nonexistent-agentoo-projects-dir'
process.env.PROJECTS_DIR = MISSING_PROJECTS_DIR
