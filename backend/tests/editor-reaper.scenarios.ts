// runEditorReap (features/editor/reaper.ts) — every removal reason the design
// doc lists by name (state != running; missing/malformed session label;
// getSessionLocation 404; resolveDockerScope 400/404/409), the one case that
// must NEVER remove anything (a non-AppError — "the database is down" stood
// in for), the orphan-runtime-dir sweep, and this install's own scoping: a
// sibling agentoo install sharing the same docker daemon (this box runs
// several) must never be inspected, let alone removed, by this one's reaper,
// and neither should a container carrying no install label at all.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import './setup-env'
import { notFound } from '../src/lib/errors'

const B = new URL('../src', import.meta.url).pathname

const TEST_PROJECTS_DIR = await mkdtemp(join(tmpdir(), 'ed-reap-'))
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SLUG = 'demo'

const realEnv = { ...(await import(`${B}/env.ts`)) } as { env: Record<string, unknown> }
const testEnv = { ...realEnv.env, PROJECTS_DIR: TEST_PROJECTS_DIR }
mock.module(`${B}/env.ts`, () => ({ env: testEnv, hasClaudeCredential: false, editorEnabled: true }))

mock.module(`${B}/features/projects/service.ts`, () => ({
  getProject: async (id: string) => {
    if (id !== PROJECT_ID) throw notFound('Project')
    return { id: PROJECT_ID, slug: SLUG }
  },
}))

type SessionOutcome =
  | { kind: 'ok'; projectId: string; worktreePath: string | null }
  | { kind: 'not-found' }
  | { kind: 'db-down' }

let sessions: Record<string, SessionOutcome> = {}
mock.module(`${B}/features/sessions/service.ts`, () => ({
  getSessionLocation: async (id: string) => {
    const outcome = sessions[id]
    if (!outcome || outcome.kind === 'not-found') throw notFound('Session')
    if (outcome.kind === 'db-down') throw new Error('database unreachable')
    return { id, projectId: outcome.projectId, worktreePath: outcome.worktreePath }
  },
}))

const { runEditorReap } = await import(`${B}/features/editor/reaper.ts`)
const { editorInstallId } = await import(`${B}/features/editor/container.ts`)

// Resolved against the SAME (mocked) PROJECTS_DIR every test in this file
// runs under, so a fixture that doesn't override the 5th `rawContainer`
// argument is, by construction, "this install's own" container.
const INSTALL_ID = await editorInstallId()
const OTHER_INSTALL_ID = 'ffffffffffff'

afterAll(async () => {
  mock.module(`${B}/env.ts`, () => realEnv)
  await rm(TEST_PROJECTS_DIR, { recursive: true, force: true })
})

async function worktreeExists(sessionId: string): Promise<string> {
  const path = join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId)
  await mkdir(path, { recursive: true })
  return path
}

/**
 * `installId` defaults to THIS install's own id -- every existing test in
 * this file that doesn't pass a 5th argument is, unchanged, building a
 * fixture that belongs to this install. Pass `null` for a container with no
 * install label at all (should exist nowhere in practice: this feature
 * stamps every editor it starts), or an explicit different id for a sibling
 * install's own container.
 */
function rawContainer(
  name: string,
  status: string,
  labels: Record<string, string>,
  installId: string | null = INSTALL_ID,
) {
  const fullLabels =
    installId === null ? labels : { ...labels, 'com.agentoo.editor.install': installId }
  return JSON.stringify({
    Id: name,
    Name: `/${name}`,
    Config: { Labels: fullLabels },
    State: { Status: status },
  })
}

interface FixtureContainer {
  Id: string
  Config?: { Labels?: Record<string, string> }
}

/**
 * A real-enough `docker ps -aq --filter label=key=value`: actually reads each
 * fixture's own labels rather than returning every fixture regardless of the
 * filter asked for. This is what makes the install-scoping tests below mean
 * anything — `listThisInstallEditorContainerIds` (container.ts) issues TWO
 * such calls (one per label) and intersects the results itself, so a fake
 * that ignored the filter argument would make every fixture "belong" to every
 * install, defeating the exact property under test.
 */
function fakeCli(lines: string[]) {
  const removed: string[] = []
  const fixtures = lines.map((l) => JSON.parse(l) as FixtureContainer)
  return {
    removed,
    async run(args: string[]) {
      if (args[0] === 'ps') {
        const filter = args[3] ?? ''
        const withoutPrefix = filter.replace(/^label=/, '')
        const eq = withoutPrefix.indexOf('=')
        const key = eq === -1 ? withoutPrefix : withoutPrefix.slice(0, eq)
        const value = eq === -1 ? '' : withoutPrefix.slice(eq + 1)
        const ids = fixtures
          .filter((c) => (c.Config?.Labels ?? {})[key] === value)
          .map((c) => c.Id)
        return { ok: true, stdout: ids.join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'inspect') {
        // Real `docker inspect` only reports what it was asked for -- the
        // trailing args after --format {{json .}}.
        const requestedIds = new Set(args.slice(4))
        const matching = lines.filter((l) => requestedIds.has((JSON.parse(l) as FixtureContainer).Id))
        return { ok: true, stdout: matching.join('\n'), stderr: '', exitCode: 0 }
      }
      if (args[0] === 'rm') {
        removed.push(args[2] as string)
        return { ok: true, stdout: '', stderr: '', exitCode: 0 }
      }
      return { ok: true, stdout: '', stderr: '', exitCode: 0 }
    },
    stream() {
      throw new Error('not used')
    },
  }
}

beforeEach(async () => {
  sessions = {}
  await rm(join(TEST_PROJECTS_DIR, SLUG), { recursive: true, force: true })
  await rm(join(TEST_PROJECTS_DIR, '.editor'), { recursive: true, force: true })
})

afterEach(async () => {
  await rm(join(TEST_PROJECTS_DIR, SLUG), { recursive: true, force: true })
  await rm(join(TEST_PROJECTS_DIR, '.editor'), { recursive: true, force: true })
})

// --- each removal reason ------------------------------------------------------

test('a non-running container is removed regardless of its labels', async () => {
  const line = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaaa', 'exited', {
    'com.agentoo.editor': '1',
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-aaaaaaaaaaaa'])
})

test('a running container with no session label at all is removed', async () => {
  const line = rawContainer('agentoo_editor-demo_s-bbbbbbbbbbbb', 'running', {
    'com.agentoo.editor': '1',
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-bbbbbbbbbbbb'])
})

test('a running container with a malformed (non-UUID) session label is removed', async () => {
  const line = rawContainer('agentoo_editor-demo_s-cccccccccccc', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': 'not-a-uuid',
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-cccccccccccc'])
})

test('getSessionLocation 404 (session gone) removes the container', async () => {
  const sessionId = '10000000-0000-4000-8000-000000000000'
  sessions[sessionId] = { kind: 'not-found' }
  const line = rawContainer('agentoo_editor-demo_s-dddddddddddd', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-dddddddddddd'])
})

test('resolveDockerScope 400 (session shares the checkout, no worktree) removes the container', async () => {
  const sessionId = '20000000-0000-4000-8000-000000000000'
  sessions[sessionId] = { kind: 'ok', projectId: PROJECT_ID, worktreePath: null }
  const line = rawContainer('agentoo_editor-demo_s-eeeeeeeeeeee', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-eeeeeeeeeeee'])
})

test('resolveDockerScope 404 (the session names a project that does not exist) removes the container', async () => {
  const sessionId = '30000000-0000-4000-8000-000000000000'
  sessions[sessionId] = {
    kind: 'ok',
    projectId: '99999999-9999-4999-8999-999999999999',
    worktreePath: '/tmp/does-not-matter',
  }
  const line = rawContainer('agentoo_editor-demo_s-f00000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-f00000000000'])
})

test('resolveDockerScope 409 (worktree registered but missing from disk) removes the container', async () => {
  const sessionId = '40000000-0000-4000-8000-000000000000'
  sessions[sessionId] = {
    kind: 'ok',
    projectId: PROJECT_ID,
    worktreePath: join(TEST_PROJECTS_DIR, SLUG, 'worktrees', sessionId), // never created
  }
  const line = rawContainer('agentoo_editor-demo_s-100000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-100000000000'])
})

test('a legitimately live container (valid scope, worktree on disk) is left alone', async () => {
  const sessionId = '50000000-0000-4000-8000-000000000000'
  const worktreePath = await worktreeExists(sessionId)
  sessions[sessionId] = { kind: 'ok', projectId: PROJECT_ID, worktreePath }
  const line = rawContainer('agentoo_editor-demo_s-200000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual([])
})

// --- install scoping: never inspect, let alone remove, another install's --
//
// This box's one docker daemon is shared by more than one agentoo install
// (a production checkout plus per-worktree dev/test copies). Before the
// install label existed, EVERY install's reaper listed EVERY editor
// container on the box and removed whichever ones ITS OWN database didn't
// recognise -- which is every other install's, all the time.

test("a sibling install's editor container survives even with an unknown session; this install's own orphan is still removed", async () => {
  const ours = rawContainer('agentoo_editor-demo_s-aaaaaaaaaaa1', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': '90000000-0000-4000-8000-000000000000',
  }) // INSTALL_ID (default) — an orphan: that session id is never registered below
  const sibling = rawContainer(
    'agentoo_editor-other_s-aaaaaaaaaaa2',
    'running',
    { 'com.agentoo.editor': '1', 'com.agentoo.editor.session': '90000000-0000-4000-8000-000000000001' },
    OTHER_INSTALL_ID,
  )
  const cli = fakeCli([ours, sibling])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-aaaaaaaaaaa1'])
})

test('an editor container with no install label at all survives too, even with an unknown session', async () => {
  const ours = rawContainer('agentoo_editor-demo_s-bbbbbbbbbbb1', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': '91000000-0000-4000-8000-000000000000',
  })
  const unlabelled = rawContainer(
    'agentoo_editor-nolabel_s-bbbbbbbbbbb2',
    'running',
    { 'com.agentoo.editor': '1', 'com.agentoo.editor.session': '91000000-0000-4000-8000-000000000001' },
    null,
  )
  const cli = fakeCli([ours, unlabelled])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual(['agentoo_editor-demo_s-bbbbbbbbbbb1'])
})

test("a sibling install's exited container is left alone too — never even inspected", async () => {
  const sibling = rawContainer(
    'agentoo_editor-other_s-ccccccccccc1',
    'exited',
    { 'com.agentoo.editor': '1' },
    OTHER_INSTALL_ID,
  )
  const cli = fakeCli([sibling])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual([])
})

// --- skip on non-AppError: never remove --------------------------------------

test('a non-AppError from the lookup (e.g. the database is down) is skipped, never removed', async () => {
  const sessionId = '60000000-0000-4000-8000-000000000000'
  sessions[sessionId] = { kind: 'db-down' }
  const line = rawContainer('agentoo_editor-demo_s-300000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  expect(cli.removed).toEqual([])
})

test('a non-AppError also protects that session’s runtime dir from the orphan sweep', async () => {
  const sessionId = '60000000-0000-4000-8000-000000000001'
  sessions[sessionId] = { kind: 'db-down' }
  const line = rawContainer('agentoo_editor-demo_s-400000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const runtimeDir = join(TEST_PROJECTS_DIR, '.editor', sessionId)
  await mkdir(runtimeDir, { recursive: true })

  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)

  expect(cli.removed).toEqual([])
  const remaining = await readdir(join(TEST_PROJECTS_DIR, '.editor'))
  expect(remaining).toContain(sessionId)
})

// --- orphan runtime dirs -------------------------------------------------------

test('a runtime dir with no container at all is removed', async () => {
  const orphanId = '70000000-0000-4000-8000-000000000000'
  await mkdir(join(TEST_PROJECTS_DIR, '.editor', orphanId), { recursive: true })
  const cli = fakeCli([])
  await runEditorReap('scheduled', cli)
  const remaining = await readdir(join(TEST_PROJECTS_DIR, '.editor')).catch(() => [])
  expect(remaining).not.toContain(orphanId)
})

test('a runtime dir whose container is still alive survives the sweep', async () => {
  const sessionId = '80000000-0000-4000-8000-000000000000'
  const worktreePath = await worktreeExists(sessionId)
  sessions[sessionId] = { kind: 'ok', projectId: PROJECT_ID, worktreePath }
  await mkdir(join(TEST_PROJECTS_DIR, '.editor', sessionId), { recursive: true })
  const line = rawContainer('agentoo_editor-demo_s-500000000000', 'running', {
    'com.agentoo.editor': '1',
    'com.agentoo.editor.session': sessionId,
  })
  const cli = fakeCli([line])
  await runEditorReap('scheduled', cli)
  const remaining = await readdir(join(TEST_PROJECTS_DIR, '.editor'))
  expect(remaining).toContain(sessionId)
})

test('a non-session-id-shaped entry in the runtime root is left alone (belt-and-braces)', async () => {
  await mkdir(join(TEST_PROJECTS_DIR, '.editor', 'not-a-session-id'), { recursive: true })
  const cli = fakeCli([])
  await runEditorReap('scheduled', cli)
  const remaining = await readdir(join(TEST_PROJECTS_DIR, '.editor'))
  expect(remaining).toContain('not-a-session-id')
})

test('a missing runtime root at all is a no-op, not an error', async () => {
  const cli = fakeCli([])
  await expect(runEditorReap('boot', cli)).resolves.toBeUndefined()
})

