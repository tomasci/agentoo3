// Adversarial edges of the System Docker page's owner resolution, on top of
// docker-system.test.ts / docker-names.test.ts: names that *look* like a
// different scope than the one they are, the `agentoo_editor-` family versus a
// project literally called `editor`, label sets that are almost-but-not-quite
// one of the three families, and hex12 prefixes that collide across projects.
//
// Pure: parseContainerOwner (names.ts) takes a plain labels object, so nothing
// here is mocked and nothing touches I/O. The join against projects/sessions
// (resolveContainerOwners, system.ts) is exercised in
// docker-system-routes.scenarios.ts instead, because importing system.ts pulls
// in the real queue module.

import { expect, test } from 'bun:test'
import './setup-env'
import {
  composeProjectName,
  containerName,
  editorContainerName,
  editorLabels,
  managedLabels,
  parseContainerOwner,
} from '../src/features/docker/names'

const SESSION = '02c7a79d-6822-4344-a346-ecdf6e42de2c'
const HEX12 = SESSION.replace(/-/g, '').slice(0, 12) // 02c7a79d6822

const labelsOf = (pairs: string[]) =>
  Object.fromEntries(
    pairs.map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1)] as [string, string]
    }),
  )

// --- names that look like a session scope but are not --------------------------

test('a repo-scope slug ending in "-s-<12hex>" stays repo scope (the join is "_s-", not "-s-")', () => {
  const slug = `foo-s-${HEX12}`
  const name = composeProjectName({ slug, sessionId: null })
  expect(name).toBe(`agentoo-foo-s-${HEX12}`)
  expect(parseContainerOwner({ 'com.docker.compose.project': name })).toEqual({
    kind: 'compose',
    slug,
    sessionId: null,
    sessionPrefix: null,
  })
})

test('a session scope of a slug that itself ends in "-s-<12hex>" recovers both halves', () => {
  const slug = 'foo-s-aaaaaaaaaaaa'
  const name = composeProjectName({ slug, sessionId: SESSION })
  expect(parseContainerOwner({ 'com.docker.compose.project': name })).toEqual({
    kind: 'compose',
    slug,
    sessionId: null,
    sessionPrefix: HEX12,
  })
})

test('a 13-hex or 11-hex session suffix is not a session scope and not a repo scope either', () => {
  expect(
    parseContainerOwner({ 'com.docker.compose.project': `agentoo-demo_s-${HEX12}a` }),
  ).toBeNull()
  expect(
    parseContainerOwner({ 'com.docker.compose.project': `agentoo-demo_s-${HEX12.slice(0, 11)}` }),
  ).toBeNull()
})

test('a doubled session suffix ("_s-x_s-y") is rejected rather than parsed as a slug', () => {
  expect(
    parseContainerOwner({
      'com.docker.compose.project': `agentoo-demo_s-${HEX12}_s-${HEX12}`,
    }),
  ).toBeNull()
})

test('an "agentoo-" prefix match is exact: "agentoodemo" and "xagentoo-demo" are not ours', () => {
  expect(parseContainerOwner({ 'com.docker.compose.project': 'agentoodemo' })).toBeNull()
  expect(parseContainerOwner({ 'com.docker.compose.project': 'xagentoo-demo' })).toBeNull()
  expect(parseContainerOwner({ 'com.docker.compose.project': 'AGENTOO-demo' })).toBeNull()
})

// --- the editor family versus a project literally named "editor" ---------------

test('a project literally named "editor" parses as that project, at repo and session scope', () => {
  expect(
    parseContainerOwner({
      'com.docker.compose.project': composeProjectName({ slug: 'editor', sessionId: null }),
    }),
  ).toEqual({ kind: 'compose', slug: 'editor', sessionId: null, sessionPrefix: null })
  expect(
    parseContainerOwner({
      'com.docker.compose.project': composeProjectName({ slug: 'editor', sessionId: SESSION }),
    }),
  ).toEqual({ kind: 'compose', slug: 'editor', sessionId: null, sessionPrefix: HEX12 })
  expect(
    parseContainerOwner(labelsOf(managedLabels({ slug: 'editor', sessionId: SESSION }))),
  ).toEqual({ kind: 'dockerfile', slug: 'editor', sessionId: SESSION, sessionPrefix: null })
})

test('an "agentoo_editor-..." string as a compose project name is never read as a project', () => {
  // The editor family's own container NAME, if something ever used it as a
  // compose project, must not be parsed into slug "editor" or anything else.
  const editorName = editorContainerName({ slug: 'demo', sessionId: SESSION })
  expect(editorName.startsWith('agentoo_editor-')).toBe(true)
  expect(parseContainerOwner({ 'com.docker.compose.project': editorName })).toBeNull()
})

test("project demo's editor container parses to slug demo, not to a project named editor", () => {
  const labels = labelsOf(editorLabels({ slug: 'demo', sessionId: SESSION }, 'install1'))
  expect(parseContainerOwner(labels)).toEqual({
    kind: 'editor',
    slug: 'demo',
    sessionId: SESSION,
    sessionPrefix: null,
  })
})

test('the plain-Dockerfile container NAME alone (no labels) carries no ownership', () => {
  // Ownership comes from labels only; a container someone merely *named*
  // like ours is an ordinary container.
  expect(containerName({ slug: 'demo', sessionId: null })).toBe('agentoo-demo')
  expect(parseContainerOwner({})).toBeNull()
})

test('com.agentoo.editor set to anything but "1" is not the editor family', () => {
  expect(
    parseContainerOwner({
      'com.agentoo.editor': 'true',
      'com.agentoo.editor.project': 'demo',
      'com.agentoo.editor.session': SESSION,
    }),
  ).toBeNull()
})

test('com.agentoo.managed set to anything but "1" is not the dockerfile family', () => {
  expect(parseContainerOwner({ 'com.agentoo.managed': 'yes', 'com.agentoo.project': 'demo' })).toBeNull()
  expect(parseContainerOwner({ 'com.agentoo.project': 'demo' })).toBeNull()
})

test('editor labels missing the session are null (editor has no repo-scope variant)', () => {
  expect(
    parseContainerOwner({ 'com.agentoo.editor': '1', 'com.agentoo.editor.project': 'demo' }),
  ).toBeNull()
})

test('an empty or foreign compose label wins over otherwise-valid agentoo dockerfile labels', () => {
  // The compose label is checked before the dockerfile family, so a
  // non-agentoo compose container that also happens to carry our dockerfile
  // labels stays unowned rather than being attributed to "demo".
  const dockerfile = { 'com.agentoo.managed': '1', 'com.agentoo.project': 'demo' }
  expect(parseContainerOwner({ ...dockerfile, 'com.docker.compose.project': 'myapp' })).toBeNull()
  expect(parseContainerOwner({ ...dockerfile, 'com.docker.compose.project': '' })).toBeNull()
})

test('slug length limits: 48 characters parses, 49 does not', () => {
  const ok = `a${'b'.repeat(46)}c`
  const tooLong = `a${'b'.repeat(47)}c`
  expect(parseContainerOwner({ 'com.docker.compose.project': `agentoo-${ok}` })?.slug).toBe(ok)
  expect(parseContainerOwner({ 'com.docker.compose.project': `agentoo-${tooLong}` })).toBeNull()
})
