import { expect, test } from 'bun:test'
import { toSlug } from '../src/lib/paths'
import {
  composeProjectLabelFilter,
  composeProjectName,
  containerName,
  imageReference,
  managedLabels,
  projectLabelFilter,
  scopeKey,
} from '../src/features/docker/names'

const repo = (slug: string) => ({ slug, sessionId: null })
const SESSION_ID = '11111111-2222-4333-8444-555555555555'
const worktree = (slug: string, sessionId = SESSION_ID) => ({ slug, sessionId })

test('compose project name is agentoo-<slug> at repo scope', () => {
  expect(composeProjectName(repo('demo'))).toBe('agentoo-demo')
})

test('container name for the plain-Dockerfile path is agentoo-<slug> at repo scope', () => {
  expect(containerName(repo('demo'))).toBe('agentoo-demo')
})

test('image reference is agentoo/<slug>:latest at repo scope', () => {
  expect(imageReference(repo('demo'))).toBe('agentoo/demo:latest')
})

test('managed labels carry both the project and the managed marker at repo scope', () => {
  expect(managedLabels(repo('demo'))).toEqual(['com.agentoo.project=demo', 'com.agentoo.managed=1'])
})

test('label filters are usable directly as --filter values', () => {
  expect(projectLabelFilter('demo')).toBe('label=com.agentoo.project=demo')
  expect(composeProjectLabelFilter(repo('demo'))).toBe('label=com.docker.compose.project=agentoo-demo')
})

test('a slug that is not [a-z0-9-] is refused rather than silently used', () => {
  expect(() => composeProjectName(repo('Demo!'))).toThrow()
  expect(() => containerName(repo('../etc'))).toThrow()
  expect(() => imageReference(repo(''))).toThrow()
  expect(() => managedLabels(repo('has spaces'))).toThrow()
})

test('every slug toSlug() can actually produce is accepted', () => {
  // toSlug() (lib/paths.ts) yields [a-z0-9-]{1,48}, no leading/trailing dash.
  // Belt-and-braces: these must never throw.
  for (const slug of ['a', 'project', 'my-project-2', 'a'.repeat(48), 'x-y-z']) {
    expect(() => composeProjectName(repo(slug))).not.toThrow()
  }
})

// --- worktree scope -----------------------------------------------------------

test('worktree scope appends _s-<hex12> to every name', () => {
  const ref = worktree('demo')
  const suffix = SESSION_ID.replace(/-/g, '').slice(0, 12)
  expect(composeProjectName(ref)).toBe(`agentoo-demo_s-${suffix}`)
  expect(containerName(ref)).toBe(`agentoo-demo_s-${suffix}`)
  expect(imageReference(ref)).toBe(`agentoo/demo_s-${suffix}:latest`)
  expect(composeProjectLabelFilter(ref)).toBe(
    `label=com.docker.compose.project=agentoo-demo_s-${suffix}`,
  )
})

test('worktree scope appends a third, provenance-only label', () => {
  expect(managedLabels(worktree('demo'))).toEqual([
    'com.agentoo.project=demo',
    'com.agentoo.managed=1',
    `com.agentoo.session=${SESSION_ID}`,
  ])
})

test('scopeKey is repo at repo scope and s-<hex12> at worktree scope', () => {
  expect(scopeKey(repo('demo'))).toBe('repo')
  expect(scopeKey(worktree('demo'))).toBe(`s-${SESSION_ID.replace(/-/g, '').slice(0, 12)}`)
})

test('the 12-hex suffix is taken from the front of the id, not the back', () => {
  // Two ids sharing their first 12 hex characters but differing only past
  // them (as these two do, in their final segment) do collide by
  // construction -- that residual risk is what the 12-char width (rather than
  // an unbounded one) accepts, and is the whole reason the width is 12 and not
  // 8. Two ids differing *within* the first 12 characters must not collide.
  const a = worktree('demo', '11111111-1111-4111-8111-111111111111')
  const b = worktree('demo', '11111111-2222-4111-8111-111111111111')
  expect(composeProjectName(a)).not.toBe(composeProjectName(b))
})

test('an invalid session id is refused rather than silently used', () => {
  expect(() => composeProjectName(worktree('demo', 'not-a-uuid'))).toThrow()
  expect(() => containerName(worktree('demo', '../../etc'))).toThrow()
})

test('projectLabelFilter stays unscoped: identical for every session of one project', () => {
  expect(projectLabelFilter('demo')).toBe('label=com.agentoo.project=demo')
})

// --- Defect 1 regression: a slug shaped like another project's session scope --

test('the historically-colliding slug is one an ordinary project name still produces', () => {
  // toSlug() happily turns "demo s <hex12>" into "demo-s-<hex12>" -- nothing
  // about that string is invalid as a slug. Before the `_` join, this was
  // exactly the string `demo`'s own session scope produced too.
  const SESSION = 'abc123de-f456-4789-8abc-def012345678'
  const suffix = SESSION.replace(/-/g, '').slice(0, 12)
  expect(toSlug(`demo s ${suffix}`)).toBe(`demo-s-${suffix}`)
})

test('Defect 1: a project slug shaped like `<slug>-s-<hex12>` no longer collides with that session scope', () => {
  const SESSION = 'abc123de-f456-4789-8abc-def012345678'
  const suffix = SESSION.replace(/-/g, '').slice(0, 12) // abc123def456
  const victimSessionScope = { slug: 'demo', sessionId: SESSION }
  const attackerRepoScope = { slug: `demo-s-${suffix}`, sessionId: null }

  expect(composeProjectName(attackerRepoScope)).not.toBe(composeProjectName(victimSessionScope))
  expect(containerName(attackerRepoScope)).not.toBe(containerName(victimSessionScope))
  expect(imageReference(attackerRepoScope)).not.toBe(imageReference(victimSessionScope))
  expect(composeProjectLabelFilter(attackerRepoScope)).not.toBe(
    composeProjectLabelFilter(victimSessionScope),
  )
})

test('Defect 1: an attacker whose slug embeds another session scope entirely still cannot forge it', () => {
  // A slug of the exact shape `<other slug>_s-<hex12>` cannot exist (SLUG_RE
  // forbids `_`), but the property that actually matters is broader than
  // that one string: no legal slug, combined with any sessionId (including
  // null), can ever produce the same composed name as a *different* legal
  // (slug, sessionId) pair. Checked here across a spread of adversarial
  // slugs that get as close to the old collision shape as SLUG_RE allows.
  const SESSION = 'abc123de-f456-4789-8abc-def012345678'
  const suffix = SESSION.replace(/-/g, '').slice(0, 12)
  const adversarialSlugs = [
    `demo-s-${suffix}`,
    `demo-s${suffix}`,
    `demos${suffix}`,
    `agentoo-demo-s-${suffix}`,
    `${'s-'.repeat(6)}${suffix}`,
  ]
  const victim = composeProjectName({ slug: 'demo', sessionId: SESSION })
  for (const slug of adversarialSlugs) {
    expect(composeProjectName({ slug, sessionId: null })).not.toBe(victim)
  }
})

// --- Defect 1: the general no-collision property, proven rather than sampled --

test('Defect 1: no two distinct (slug, sessionId) pairs ever produce the same name', () => {
  // Property test, not a fixed example: many random legal slugs (including
  // ones deliberately shaped like `<slug>-s-<hex>`, `<slug>-s<hex>` -- every
  // string SLUG_RE admits that comes close to the old collision shape) times
  // both repo scope and several session ids, checked pairwise for the compose
  // project name (the same argument covers containerName/imageReference,
  // which share the identical join).
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  function randomSlug(rng: () => number, biasDashS: boolean): string {
    if (biasDashS) {
      // Deliberately construct slugs of the shape this bug lived in:
      // "<random>-s-<hex-like>" and "<random>-s<hex-like>".
      const head = Array.from(
        { length: 1 + Math.floor(rng() * 10) },
        () => alphabet[Math.floor(rng() * 26)],
      ).join('')
      const hexish = Array.from(
        { length: 12 },
        () => '0123456789abcdef'[Math.floor(rng() * 16)],
      ).join('')
      return rng() < 0.5 ? `${head}-s-${hexish}` : `${head}-s${hexish}`
    }
    const len = 1 + Math.floor(rng() * 40)
    let s = alphabet[Math.floor(rng() * 26)] as string
    for (let i = 1; i < len; i++) {
      s += rng() < 0.15 && i < len - 1 ? '-' : (alphabet[Math.floor(rng() * alphabet.length)] as string)
    }
    return s
  }
  // A small deterministic PRNG (mulberry32) so a failure is reproducible
  // without pinning bun:test to a particular Math.random implementation.
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
  const rng = mulberry32(42)
  const sessionIds = [
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    'abc123de-f456-4789-8abc-def012345678',
  ]
  const names = new Map<string, string>()
  let collisions = 0
  for (let i = 0; i < 4000; i++) {
    const slug = randomSlug(rng, i % 3 === 0)
    const candidates: { slug: string; sessionId: string | null }[] = [
      { slug, sessionId: null },
      ...sessionIds.map((sessionId) => ({ slug, sessionId })),
    ]
    for (const ref of candidates) {
      let name: string
      try {
        name = composeProjectName(ref)
      } catch {
        continue // an invalid slug this generator produced; not this test's concern
      }
      const key = `${ref.slug} ${ref.sessionId}`
      const existingKey = names.get(name)
      if (existingKey !== undefined && existingKey !== key) collisions++
      names.set(name, key)
    }
  }
  expect(collisions).toBe(0)
  expect(names.size).toBeGreaterThan(1000)
})
