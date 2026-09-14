import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { composeEnvFor } from '../src/features/docker/compose-env'

const REPO = { slug: 'demo', sessionId: null }
const WORKTREE = { slug: 'demo', sessionId: '11111111-2222-4333-8444-555555555555' }

test('deterministic: the same scope always yields the same env, across calls', () => {
  expect(composeEnvFor(REPO)).toEqual(composeEnvFor(REPO))
  expect(composeEnvFor(WORKTREE)).toEqual(composeEnvFor(WORKTREE))
})

test('every port is a string, in range 20000-31999, and ten consecutive values', () => {
  const env = composeEnvFor(REPO)
  const ports = Array.from({ length: 10 }, (_, i) => Number(env[`AGENTOO_PORT_${i}`]))
  for (const port of ports) {
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(20000)
    expect(port).toBeLessThanOrEqual(31999)
  }
  for (let i = 1; i < ports.length; i++) {
    expect(ports[i]).toBe((ports[0] as number) + i)
  }
})

test('AGENTOO_PORT_0 is exactly the base -- no arithmetic left for a compose file to do', () => {
  const env = composeEnvFor(REPO)
  const anotherRead = composeEnvFor(REPO)
  // The claim is determinism (a second, independent call agrees with the
  // first), not reflexivity -- `expect(x).toBe(x)` can never fail and used to
  // stand in for this.
  expect(anotherRead.AGENTOO_PORT_0).toBe(env.AGENTOO_PORT_0)
  for (let i = 0; i < 10; i++) {
    expect(Number(env[`AGENTOO_PORT_${i}`])).toBe(Number(env.AGENTOO_PORT_0) + i)
  }
})

test('repo scope carries AGENTOO_SCOPE=repo and no AGENTOO_SESSION_ID at all', () => {
  const env = composeEnvFor(REPO)
  expect(env.AGENTOO_SCOPE).toBe('repo')
  expect('AGENTOO_SESSION_ID' in env).toBe(false)
})

test('worktree scope carries AGENTOO_SCOPE=worktree and the full session id', () => {
  const env = composeEnvFor(WORKTREE)
  expect(env.AGENTOO_SCOPE).toBe('worktree')
  expect(env.AGENTOO_SESSION_ID).toBe(WORKTREE.sessionId)
})

test('AGENTOO_PROJECT_SLUG and AGENTOO_COMPOSE_PROJECT reflect the scope', () => {
  const repoEnv = composeEnvFor(REPO)
  const worktreeEnv = composeEnvFor(WORKTREE)
  expect(repoEnv.AGENTOO_PROJECT_SLUG).toBe('demo')
  expect(repoEnv.AGENTOO_COMPOSE_PROJECT).toBe('agentoo-demo')
  expect(worktreeEnv.AGENTOO_PROJECT_SLUG).toBe('demo')
  expect(worktreeEnv.AGENTOO_COMPOSE_PROJECT).toBe(
    `agentoo-demo_s-${WORKTREE.sessionId.replace(/-/g, '').slice(0, 12)}`,
  )
})

test('repo and worktree scope of the same project get different port ranges', () => {
  // Not a hard requirement (a hash collision is legal), but the whole point of
  // keying the range on the compose project name rather than the bare slug --
  // asserted here so a regression that keyed on slug alone would be caught.
  const repoEnv = composeEnvFor(REPO)
  const worktreeEnv = composeEnvFor(WORKTREE)
  expect(repoEnv.AGENTOO_PORT_0).not.toBe(worktreeEnv.AGENTOO_PORT_0)
})

test('a compose file referencing AGENTOO_* gets the same keys at both scopes', () => {
  // Injected at both scopes deliberately -- see this module's own header on why
  // injecting only at worktree scope would make one file behave two ways.
  const repoKeys = Object.keys(composeEnvFor(REPO)).filter((k) => k !== 'AGENTOO_SESSION_ID')
  const worktreeKeys = Object.keys(composeEnvFor(WORKTREE)).filter((k) => k !== 'AGENTOO_SESSION_ID')
  expect(repoKeys.sort()).toEqual(worktreeKeys.sort())
})

// --- broad sampling: one slug (or one session id) proves nothing about a hash ---
//
// A hash that collapsed every input into a single bucket would satisfy every
// per-value assertion above (range, string-ness, consecutive ports) while
// providing no real spread at all -- these two tests are what would actually
// catch that, by sampling thousands of distinct inputs and asserting the
// number of distinct buckets they land in.

function randomSlug(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const len = 1 + Math.floor(Math.random() * 40)
  let s = alphabet[Math.floor(Math.random() * 26)] as string
  for (let i = 1; i < len; i++) {
    const c = alphabet[Math.floor(Math.random() * alphabet.length)] as string
    s += Math.random() < 0.15 && i < len - 1 ? '-' : c
  }
  return s
}

test('20000 random repo scopes: base in 20000..31990, ports base+0..base+9, all strings', () => {
  const bases = new Set<number>()
  for (let i = 0; i < 20000; i++) {
    const env = composeEnvFor({ slug: randomSlug(), sessionId: null })
    const base = Number(env.AGENTOO_PORT_0)
    expect(Number.isInteger(base)).toBe(true)
    expect(base).toBeGreaterThanOrEqual(20000)
    expect(base).toBeLessThanOrEqual(31990)
    expect(base % 10).toBe(0)
    for (let p = 0; p < 10; p++) {
      const v = env[`AGENTOO_PORT_${p}`]
      expect(typeof v).toBe('string')
      expect(Number(v)).toBe(base + p)
      expect(Number(v)).toBeLessThanOrEqual(31999)
    }
    bases.add(base)
  }
  // The spread check a single sampled slug cannot provide: a hash that
  // collapsed every input to one bucket would still satisfy every assertion
  // above.
  expect(bases.size).toBeGreaterThan(1000)
})

test('20000 random worktree scopes: same range, and the session id is present in full', () => {
  const bases = new Set<number>()
  for (let i = 0; i < 20000; i++) {
    const sessionId = randomUUID()
    const env = composeEnvFor({ slug: 'demo', sessionId })
    const base = Number(env.AGENTOO_PORT_0)
    expect(base).toBeGreaterThanOrEqual(20000)
    expect(base).toBeLessThanOrEqual(31990)
    expect(env.AGENTOO_SESSION_ID).toBe(sessionId)
    expect(env.AGENTOO_SCOPE).toBe('worktree')
    expect(Number(env.AGENTOO_PORT_9)).toBe(base + 9)
    bases.add(base)
  }
  expect(bases.size).toBeGreaterThan(1000)
})

test('deterministic across a separate process (a restart recomputes the same ports)', async () => {
  const cases = [
    { slug: 'demo', sessionId: null },
    { slug: 'my-project', sessionId: null },
    { slug: 'demo', sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
    { slug: 'z'.repeat(48), sessionId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' },
  ]
  const here = cases.map((c) => composeEnvFor(c))
  const script = `
    import { composeEnvFor } from ${JSON.stringify(new URL('../src/features/docker/compose-env.ts', import.meta.url).pathname)}
    console.log(JSON.stringify(${JSON.stringify(cases)}.map((c) => composeEnvFor(c))))
  `
  const proc = Bun.spawn(['bun', 'run', '-'], { stdin: new TextEncoder().encode(script), stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  expect(JSON.parse(out.trim())).toEqual(here)
})
