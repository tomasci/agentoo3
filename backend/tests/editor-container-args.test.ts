// editorRunArgs (features/editor/container.ts) — the exact argv `docker run`
// gets, snapshotted the same way docker-args.test.ts pins runArgs/buildArgs:
// this is the feature's real security boundary (no shell, every value its own
// array element) as well as its behaviour.

import { expect, test } from 'bun:test'
import './setup-env'
import { env } from '../src/env'
import { editorRunArgs } from '../src/features/editor/container'

// No env mock here, deliberately: `mock.module('@/env.ts', ...)` mutates the
// one shared, already-loaded env module in place (see bun:test's own docs:
// "if the module is already loaded, exports are overwritten"), which is safe
// only for the file that owns the mock's whole lifetime — every other test
// file sharing this same `bun test` process reads through the SAME live
// binding, so a window where this file's mock is installed is a window where
// an unrelated file's own env-dependent test can observe it too. This file's
// assertions build their expected argv from the REAL, running environment's
// EDITOR_* defaults instead, which is exactly what a fresh checkout's env.ts
// already resolves them to (see .env.example / backend/README.md's "Editor").

const SESSION_ID = '11111111-2222-4333-8444-555555555555'
const SUFFIX = SESSION_ID.replace(/-/g, '').slice(0, 12)
const REF = { slug: 'demo', sessionId: SESSION_ID }
const INSTALL_ID = 'abc123def456'
const OPTS = {
  worktreePath: '/opt/agentoo/projects/demo/worktrees/11111111-2222-4333-8444-555555555555',
  gitCommonDir: '/opt/agentoo/projects/demo/repo/.git',
  runtimeDir: '/opt/agentoo/projects/.editor/11111111-2222-4333-8444-555555555555',
  uid: 1001,
  gid: 1001,
  installId: INSTALL_ID,
}

test('editorRunArgs produces the exact argv the design doc specifies', () => {
  expect(editorRunArgs(REF, OPTS)).toEqual([
    'run',
    '-d',
    '--name',
    `agentoo_editor-demo_s-${SUFFIX}`,
    '--label',
    'com.agentoo.editor=1',
    '--label',
    `com.agentoo.editor.session=${SESSION_ID}`,
    '--label',
    'com.agentoo.editor.project=demo',
    '--label',
    `com.agentoo.editor.install=${INSTALL_ID}`,
    '--init',
    '--entrypoint',
    '/usr/bin/code-server',
    '--user',
    '1001:1001',
    '--network',
    'none',
    '--security-opt',
    'no-new-privileges:true',
    '--cap-drop',
    'ALL',
    '--memory',
    env.EDITOR_MEMORY_LIMIT,
    '--cpus',
    String(env.EDITOR_CPUS),
    '--pids-limit',
    '512',
    '--restart',
    'no',
    '--workdir',
    OPTS.worktreePath,
    '--env',
    'HOME=/tmp/home',
    '--env',
    'SHELL=/bin/bash',
    '--mount',
    `type=bind,src=${OPTS.worktreePath},dst=${OPTS.worktreePath}`,
    '--mount',
    `type=bind,src=${OPTS.gitCommonDir},dst=${OPTS.gitCommonDir}`,
    '--mount',
    `type=bind,src=${OPTS.runtimeDir},dst=/run/agentoo-editor`,
    env.EDITOR_IMAGE,
    '--socket',
    '/run/agentoo-editor/code-server.sock',
    '--auth',
    'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--disable-getting-started-override',
    '--disable-proxy',
    '--idle-timeout-seconds',
    String(env.EDITOR_IDLE_TIMEOUT_SECONDS),
    '--user-data-dir',
    '/tmp/home/.local/share/code-server',
    '--extensions-dir',
    '/tmp/home/.local/share/code-server/extensions',
    OPTS.worktreePath,
  ])
})

test('every -v is absent: mounts are always --mount type=bind', () => {
  const args = editorRunArgs(REF, OPTS)
  expect(args).not.toContain('-v')
  const mountIndexes = args.reduce<number[]>((acc, arg, i) => {
    if (arg === '--mount') acc.push(i)
    return acc
  }, [])
  expect(mountIndexes).toHaveLength(3)
  for (const i of mountIndexes) {
    expect(args[i + 1]).toMatch(/^type=bind,src=.+,dst=.+$/)
  }
})

test('--network none, --cap-drop ALL and no --restart policy beyond "no"', () => {
  const args = editorRunArgs(REF, OPTS)
  const at = (flag: string) => args[args.indexOf(flag) + 1]
  expect(at('--network')).toBe('none')
  expect(at('--cap-drop')).toBe('ALL')
  expect(at('--restart')).toBe('no')
  expect(at('--security-opt')).toBe('no-new-privileges:true')
})

test('--user is exactly <uid>:<gid> from the passed-in stat result', () => {
  const args = editorRunArgs(REF, { ...OPTS, uid: 2000, gid: 2001 })
  expect(args[args.indexOf('--user') + 1]).toBe('2000:2001')
})

test('the image reference sits between the mounts and the code-server flags', () => {
  const args = editorRunArgs(REF, OPTS)
  const imageIndex = args.indexOf(env.EDITOR_IMAGE)
  expect(imageIndex).toBeGreaterThan(0)
  expect(args[imageIndex + 1]).toBe('--socket')
})

test('the container name and labels come from editorContainerName/editorLabels, not reinvented here', () => {
  const args = editorRunArgs({ slug: 'other', sessionId: SESSION_ID }, OPTS)
  expect(args[args.indexOf('--name') + 1]).toBe(`agentoo_editor-other_s-${SUFFIX}`)
  expect(args).toContain('com.agentoo.editor.project=other')
})

test('the install label reflects the installId passed in opts, not a fixed value', () => {
  const args = editorRunArgs(REF, { ...OPTS, installId: 'different0id' })
  expect(args).toContain('com.agentoo.editor.install=different0id')
  expect(args).not.toContain(`com.agentoo.editor.install=${INSTALL_ID}`)
})

test('an invalid slug or session id still throws before any argv is built', () => {
  expect(() => editorRunArgs({ slug: 'Bad Slug', sessionId: SESSION_ID }, OPTS)).toThrow()
  expect(() => editorRunArgs({ slug: 'demo', sessionId: 'not-a-uuid' }, OPTS)).toThrow()
})
