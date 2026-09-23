// resolveDockerScope (features/docker/scope.ts): every one of its seven
// resolution outcomes, and — the property the rest of this feature leans on —
// that a cross-project session id is byte-identical to an unknown one.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { AppError, notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'agentoo-docker-scope-'))

const realEnv = { ...(await import(`${B}/env.ts`)) } as {
  env: Record<string, unknown>
  hasClaudeCredential: boolean
  editorEnabled: boolean
}
const testEnv = { ...realEnv.env, PROJECTS_DIR: TEST_PROJECTS_DIR }
mock.module(`${B}/env.ts`, () => ({
  env: testEnv,
  hasClaudeCredential: realEnv.hasClaudeCredential,
  // Additive: features/editor didn't exist when this file was written.
  // Kept, not spread from realEnv wholesale, for the same reason this
  // file's own `env` override isn't a spread either -- see run-isolated.ts's
  // header for why an ADDITIVE, hard-coded mock still has to carry every
  // named export another concurrently-running test file might import.
  editorEnabled: realEnv.editorEnabled,
}))

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const SLUG = 'demo'

// Spread from the real modules, not hand-rolled: both specifiers have real
// consumers elsewhere in this suite (every other feature that touches a
// project or a session), and `mock.module` replaces a specifier for the
// whole test process. Restored in afterAll for the same reason.
const realProjects = { ...(await import(`${B}/features/projects/service.ts`)) } as Record<
  string,
  unknown
>
const realSessions = { ...(await import(`${B}/features/sessions/service.ts`)) } as Record<
  string,
  unknown
>

let projectExists = true
/** Mutated by the guard-breach test below; every other test leaves it alone. */
let projectSlug: string = SLUG
mock.module(`${B}/features/projects/service.ts`, () => ({
  ...realProjects,
  getProject: async (id: string) => {
    if (id === PROJECT_ID && projectExists) return { id: PROJECT_ID, slug: projectSlug }
    throw notFound('Project')
  },
  listProjects: async () => [],
}))

interface SessionRow {
  id: string
  projectId: string
  worktreePath: string | null
}
let sessionsById: Record<string, SessionRow> = {}
mock.module(`${B}/features/sessions/service.ts`, () => ({
  ...realSessions,
  getSessionLocation: async (id: string) => {
    const row = sessionsById[id]
    if (!row) throw notFound('Session')
    return row
  },
}))

const { resolveDockerScope } = await import(`${B}/features/docker/scope.ts`)

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  mock.module(`${B}/features/projects/service.ts`, () => realProjects)
  mock.module(`${B}/features/sessions/service.ts`, () => realSessions)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  projectExists = true
  projectSlug = SLUG
  sessionsById = {}
})

async function status(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
    return { status: 200, message: '' }
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, message: error.message }
    throw error
  }
}

// --- 1: unknown project --------------------------------------------------------

test('an unknown project is a 404, before anything about a session is looked at', async () => {
  projectExists = false
  const result = await status(resolveDockerScope(PROJECT_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
  expect(result).toEqual({ status: 404, message: 'Project not found' })
})

// --- 2: no sessionId -> repo scope, no stat ------------------------------------

test('no sessionId resolves to repo scope without touching the filesystem', async () => {
  // PROJECTS_DIR/demo/repo is never created in this test file at all — if this
  // stat'd, it would 409, which is exactly the behaviour repo scope must not
  // start having.
  const scope = await resolveDockerScope(PROJECT_ID)
  expect(scope).toEqual({
    projectId: PROJECT_ID,
    slug: SLUG,
    sessionId: null,
    path: join(TEST_PROJECTS_DIR, SLUG, 'repo'),
  })
})

// --- 3 & 4: unknown session, and a cross-project one, are indistinguishable ----

test('an unknown session id is a 404', async () => {
  const result = await status(resolveDockerScope(PROJECT_ID, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
  expect(result).toEqual({ status: 404, message: 'Session not found' })
})

test("a session belonging to a different project is byte-identical to an unknown one", async () => {
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  sessionsById[sessionId] = { id: sessionId, projectId: OTHER_PROJECT_ID, worktreePath: '/tmp/x' }

  const crossProject = await status(resolveDockerScope(PROJECT_ID, sessionId))
  const unknown = await status(
    resolveDockerScope(PROJECT_ID, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  )
  expect(crossProject).toEqual({ status: 404, message: 'Session not found' })
  expect(crossProject).toEqual(unknown)
})

// --- 5: shares the checkout -----------------------------------------------------

test('a session with no worktree of its own is a 400, and does not fall back to repo scope', async () => {
  const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: null }
  const result = await status(resolveDockerScope(PROJECT_ID, sessionId))
  expect(result.status).toBe(400)
  expect(result.message).toContain('has no worktree of its own')
})

// --- 6: a guard breach is a 500, not a handled client error --------------------

test('a worktree path that would escape PROJECTS_DIR throws a plain Error, not an AppError', async () => {
  // Exercises the invariant, not a real client input: assertInsideProjects
  // guards against `projectWorktree` ever producing something outside
  // PROJECTS_DIR, which can only happen if project.slug itself is not the
  // sanitized value toSlug() always produces — a guard breach upstream, not
  // something a caller of this function can trigger through valid input.
  projectSlug = '../../etc'
  const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: '/tmp/x' }

  let caught: unknown
  try {
    await resolveDockerScope(PROJECT_ID, sessionId)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect(caught).not.toBeInstanceOf(AppError)
})

// --- 7: worktree no longer on disk ---------------------------------------------

test('a worktree that is registered but no longer on disk is a 409, not a 404', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000000'
  const path = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: path }
  // Deliberately never created.
  const result = await status(resolveDockerScope(PROJECT_ID, sessionId))
  expect(result).toEqual({ status: 409, message: 'The worktree for this session is no longer on disk' })
})

test('a worktree that does exist on disk resolves to worktree scope', async () => {
  const sessionId = '10000000-0000-4000-8000-000000000000'
  const path = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  await mkdir(path, { recursive: true })
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: path }

  const scope = await resolveDockerScope(PROJECT_ID, sessionId)
  expect(scope).toEqual({ projectId: PROJECT_ID, slug: SLUG, sessionId, path })
})

test('the resolved worktree path is derived, not the raw column value: a column pointing elsewhere is ignored', async () => {
  // A column equal to the derived value would pass identically whether
  // resolveDockerScope derives the path or simply trusts the column -- it
  // does not discriminate. Pointing the column somewhere else entirely (an
  // unrelated directory that DOES exist on disk, so a wrong implementation
  // would not merely 409) is what actually pins that the column is read only
  // as an "is this session isolated" flag, never as the source of truth for
  // where the worktree lives.
  const sessionId = '20000000-0000-4000-8000-000000000000'
  const derived = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  await mkdir(derived, { recursive: true })
  const elsewhere = await mkdtemp(join(tmpdir(), 'agentoo-docker-scope-elsewhere-'))
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: elsewhere }

  const scope = await resolveDockerScope(PROJECT_ID, sessionId)
  expect(scope.path).toBe(derived)
  expect(scope.path).not.toBe(elsewhere)
  await rm(elsewhere, { recursive: true, force: true })
})

test('a column pointing outside PROJECTS_DIR entirely cannot steer the scope', async () => {
  const sessionId = '30000000-0000-4000-8000-000000000000'
  const derived = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  await mkdir(derived, { recursive: true })
  sessionsById[sessionId] = { id: sessionId, projectId: PROJECT_ID, worktreePath: '/etc' }

  const scope = await resolveDockerScope(PROJECT_ID, sessionId)
  expect(scope.path).toBe(derived)
})
