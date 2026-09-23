// editorContainerName/editorLabels/EDITOR_LABEL_FILTER (features/docker/names.ts)
// — the naming family that keeps an editor container invisible to
// listScopeContainers, the session pre-delete gate, and the Docker page.

import { expect, test } from 'bun:test'
import {
  composeProjectName,
  containerName,
  imageReference,
  managedLabels,
} from '../src/features/docker/names'
import {
  EDITOR_LABEL_FILTER,
  editorContainerName,
  editorInstallLabelFilter,
  editorLabels,
} from '../src/features/docker/names'

const SESSION_ID = '11111111-2222-4333-8444-555555555555'
const SUFFIX = SESSION_ID.replace(/-/g, '').slice(0, 12)
const INSTALL_ID = 'abc123def456'
const ref = (slug: string, sessionId = SESSION_ID) => ({ slug, sessionId })

test('editor container name is agentoo_editor-<slug>_s-<hex12>', () => {
  expect(editorContainerName(ref('demo'))).toBe(`agentoo_editor-demo_s-${SUFFIX}`)
})

test('editor labels are the com.agentoo.editor* family, exactly four, including the install discriminator', () => {
  expect(editorLabels(ref('demo'), INSTALL_ID)).toEqual([
    'com.agentoo.editor=1',
    `com.agentoo.editor.session=${SESSION_ID}`,
    'com.agentoo.editor.project=demo',
    `com.agentoo.editor.install=${INSTALL_ID}`,
  ])
})

test('EDITOR_LABEL_FILTER is usable directly as a --filter value', () => {
  expect(EDITOR_LABEL_FILTER).toBe('label=com.agentoo.editor=1')
})

test('editorInstallLabelFilter builds the narrower half of the reaper\'s AND', () => {
  expect(editorInstallLabelFilter(INSTALL_ID)).toBe(`label=com.agentoo.editor.install=${INSTALL_ID}`)
})

test('an invalid slug or session id is refused, same as the docker-feature names', () => {
  expect(() => editorContainerName(ref('Demo!'))).toThrow()
  expect(() => editorContainerName(ref('../etc'))).toThrow()
  expect(() => editorContainerName(ref('demo', 'not-a-uuid'))).toThrow()
  expect(() => editorLabels(ref('has spaces'), INSTALL_ID)).toThrow()
  expect(() => editorLabels(ref('demo', '../../etc'), INSTALL_ID)).toThrow()
})

// --- editor labels never carry a docker-feature key -----------------------

const DOCKER_LABEL_KEYS = ['com.agentoo.project', 'com.agentoo.managed', 'com.agentoo.session']

test('editor labels never include a docker-feature label key, at repo or worktree scope', () => {
  for (const labels of [
    editorLabels(ref('demo'), INSTALL_ID),
    editorLabels(ref('demo-project-2'), INSTALL_ID),
  ]) {
    for (const label of labels) {
      const key = label.split('=')[0]
      expect(DOCKER_LABEL_KEYS).not.toContain(key)
      expect(key?.startsWith('com.docker.compose.')).toBe(false)
    }
  }
})

// --- property test: no editor name ever equals a docker-feature name ------
//
// The two families are disjoint by construction (`agentoo_` vs `agentoo-`,
// and SLUG_RE forbids `_` in a slug — see names.ts's own header), not merely
// by the fixed examples above. Exercised the same way docker-names.test.ts's
// own no-collision property test is: a deterministic PRNG over a spread of
// slugs (including ones shaped like the editor prefix itself) and session ids,
// checked pairwise against every docker-feature naming function.

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSlug(rng: () => number, biasEditor: boolean): string {
  if (biasEditor) {
    // Slugs deliberately shaped to get as close to `editor-<slug>` or
    // `<slug>-editor` as SLUG_RE allows — the adversarial shapes most likely
    // to produce a collision with the editor family if the `_`/`-` split
    // were ever weakened.
    const head = Array.from(
      { length: 1 + Math.floor(rng() * 8) },
      () => ALPHABET[Math.floor(rng() * 26)],
    ).join('')
    return rng() < 0.5 ? `${head}-editor` : `editor-${head}`
  }
  const len = 1 + Math.floor(rng() * 40)
  let s = ALPHABET[Math.floor(rng() * 26)] as string
  for (let i = 1; i < len; i++) {
    s += rng() < 0.15 && i < len - 1 ? '-' : (ALPHABET[Math.floor(rng() * ALPHABET.length)] as string)
  }
  return s
}

test('no (slug, sessionId) pair ever produces an editor name equal to any docker-feature name', () => {
  const rng = mulberry32(7)
  const sessionIds = [
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    SESSION_ID,
  ]
  let checked = 0
  for (let i = 0; i < 3000; i++) {
    const slug = randomSlug(rng, i % 3 === 0)
    for (const sessionId of sessionIds) {
      let editorName: string
      let dockerNames: string[]
      try {
        editorName = editorContainerName({ slug, sessionId })
        dockerNames = [
          composeProjectName({ slug, sessionId }),
          composeProjectName({ slug, sessionId: null }),
          containerName({ slug, sessionId }),
          containerName({ slug, sessionId: null }),
          imageReference({ slug, sessionId }),
          imageReference({ slug, sessionId: null }),
        ]
      } catch {
        continue // an invalid slug this generator produced; not this test's concern
      }
      for (const dockerName of dockerNames) expect(editorName).not.toBe(dockerName)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(1000)
})

test('editor labels never equal a managedLabels() entry, at either scope', () => {
  const editor = editorLabels(ref('demo'), INSTALL_ID)
  const dockerRepo = managedLabels({ slug: 'demo', sessionId: null })
  const dockerWorktree = managedLabels({ slug: 'demo', sessionId: SESSION_ID })
  for (const label of editor) {
    expect(dockerRepo).not.toContain(label)
    expect(dockerWorktree).not.toContain(label)
  }
})
