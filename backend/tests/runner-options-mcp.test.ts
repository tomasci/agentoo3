// The seam between the skills a project actually has and the SDK options a
// session actually runs with.
//
// Nothing tested skillMcpServers *through* optionsFor: the reader had unit
// tests over synthetic directories, and optionsFor had none at all. This
// covers the three things that decide whether the browser and docker skills
// work at session time:
//
//   - `mcpServers` is built from the *plugin* copy of skills/, so a real
//     shipped mcp.json placed there reaches Options.mcpServers;
//   - `strictMcpConfig`/`skipMcpDiscovery` are set, which is what makes that
//     the only path servers can arrive by;
//   - the AGENTOO_* env the docker skill reads is present, and at repo scope
//     AGENTOO_SESSION_ID is *absent as a key*, not an empty string.
//
// The child process (runner-options-mcp-child.ts) fakes only the four modules
// that need a database or a live checkout.
//
// Every run here is deliberately polluted: `runChild` strips whatever
// `AGENTOO_*` the ambient environment happens to carry and injects a fixed,
// stale set of its own. Both halves matter. Stripping first is what makes
// these tests behave identically on a developer box with no `AGENTOO_*` set
// and on this one, which self-hosts the app and therefore has all sixteen of
// them in every process. Injecting after is what keeps them *meaningful*:
// `optionsFor` builds its env from `{ ...process.env, ... }`, so "this key is
// absent" is only a real claim when something was there to inherit. The
// earlier version of this file relied on the ambient set for that, which made
// it pass or fail on where it ran and in what order — it was green in the
// full suite and red in isolation, over a genuine bug.

import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import './setup-env'
import { composeEnvFor } from '../src/features/docker/compose-env'

const BACKEND = new URL('..', import.meta.url).pathname
const REPO = join(BACKEND, '..')
const SLUG = 'demo'

interface Facts {
  [key: string]: {
    cwd: string
    mcpServers: Record<string, unknown> | null
    hasMcpServersKey: boolean
    strictMcpConfig: boolean
    plugins: { type: string; path: string; skipMcpDiscovery?: boolean }[]
    agentooEnv: Record<string, string>
    hasSessionIdKey: boolean
    unrelatedVar: string | null
  }
}

/** The ids runner-options-mcp-child.ts builds its fake session from. */
const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'

/**
 * What a worker process on a self-hosting box actually carries: this app runs
 * its own sessions, so the process assembling options for session B is itself
 * a child of session A and inherits A's whole `AGENTOO_*` block. Values are
 * deliberately unlike anything this test's own scope would derive, so a stale
 * one surviving is unmistakable rather than coincidentally equal.
 *
 * `AGENTOO_FUTURE_KEY` is not a real variable and is the point: the strip in
 * `optionsFor` derives what is authoritative from `composeEnvFor`'s own
 * return value, so it must remove an `AGENTOO_*` key it has never heard of
 * too. A hardcoded deny-list would leave this one in.
 */
const STALE_ENV: Record<string, string> = {
  AGENTOO_SESSION_ID: '99999999-9999-4999-8999-999999999999',
  AGENTOO_SCOPE: 'worktree',
  AGENTOO_PROJECT_SLUG: 'some-other-project',
  AGENTOO_COMPOSE_PROJECT: 'agentoo-some-other-project_s-deadbeef1234',
  AGENTOO_PROJECT_ID: '00000000-0000-4000-8000-000000000000',
  AGENTOO_API_BASE: 'http://stale.example:1/api',
  AGENTOO_FUTURE_KEY: 'invented-here-never-emitted-by-composeEnvFor',
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`AGENTOO_PORT_${i}`, String(29990 + i)]),
  ),
}

/** A non-AGENTOO_ variable, to prove the strip is not over-broad. */
const UNRELATED = { UNRELATED_TEST_VAR: 'must-survive' }

interface ChildOptions {
  backendHost?: string
  /** Defaults to STALE_ENV; pass `{}` for the clean-box case. */
  pollution?: Record<string, string>
}

/** A projects root with `demo/plugin/skills/` populated from `seedSkills`. */
async function runChild(seedSkills: string[], options: ChildOptions = {}): Promise<Facts> {
  const { backendHost = '0.0.0.0', pollution = STALE_ENV } = options
  const projects = await mkdtemp(join(tmpdir(), 'agentoo-runner-options-'))
  const skillsDir = join(projects, SLUG, 'plugin', 'skills')
  await mkdir(skillsDir, { recursive: true })
  for (const name of seedSkills) {
    await cp(join(REPO, 'library.example', 'skills', name), join(skillsDir, name), {
      recursive: true,
    })
  }

  // Ambient AGENTOO_* dropped so the run is identical on any box — see this
  // file's header. Everything else in process.env is kept, because the child
  // needs PATH/HOME to start at all.
  const ambient: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AGENTOO_') || value === undefined) continue
    ambient[key] = value
  }

  const proc = Bun.spawn(['bun', join(BACKEND, 'tests', 'runner-options-mcp-child.ts')], {
    cwd: BACKEND,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...ambient,
      ...pollution,
      ...UNRELATED,
      PROJECTS_DIR: projects,
      LIBRARY_DIR: join(projects, 'library'),
      ATTACHMENTS_DIR: join(projects, 'attachments'),
      BACKEND_HOST: backendHost,
      BACKEND_PORT: '8000',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      REDIS_URL: 'redis://127.0.0.1:1',
      LOG_LEVEL: '1',
      TEST_PLUGIN_SKILLS: seedSkills.join(','),
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`child exited ${code}\n${stderr}\n${stdout}`)
  const match = stdout.match(/__FACTS__(.*)__FACTS__/s)
  if (!match?.[1]) throw new Error(`no facts in child output:\n${stdout}\n${stderr}`)
  return JSON.parse(match[1]) as Facts
}

/** The authoritative AGENTOO_* block for a scope, from the same function
 * `optionsFor` uses — never a hand-copied set of names and port numbers, so
 * this cannot drift from what the docker-op worker derives for the same
 * scope. `composeEnvFor` is pure and imports nothing but `./names`, so it is
 * safe to call directly in the test process. */
function expectedScopeEnv(sessionId: string | null): Record<string, string> {
  return composeEnvFor({ slug: SLUG, sessionId })
}

const shipped = await runChild(['browser', 'docker'])

test('the shipped browser skill in a project plugin dir becomes Options.mcpServers', async () => {
  // Byte-identical passthrough, checked against the shipped file rather than
  // a second copy of the literal: the property this test owns is "whatever
  // mcp.json says reaches the SDK unchanged". library-example-shipped.test.ts
  // owns the exact argv itself, so there is one place to update and no way
  // for the two to disagree about what is shipped.
  const onDisk = JSON.parse(
    await readFile(join(REPO, 'library.example', 'skills', 'browser', 'mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, unknown> }

  expect(shipped.worktree?.mcpServers).toEqual({ playwright: onDisk.mcpServers.playwright })

  // Spelled out too, because a reader of this file should be able to see that
  // the output-dir flags actually survive the trip — they are what keeps
  // default-named screenshots out of the session's own git worktree.
  const args = (shipped.worktree?.mcpServers?.playwright as { args: string[] }).args
  expect(args).toContain('--output-dir')
  expect(args[args.indexOf('--output-dir') + 1]).toBe('/opt/agentoo/browser-output')
  expect(args[args.indexOf('--output-max-size') + 1]).toBe('209715200')
})

test('plugin discovery is off and strict MCP config is on, so that is the only path in', () => {
  expect(shipped.worktree?.strictMcpConfig).toBe(true)
  expect(shipped.worktree?.plugins?.[0]?.skipMcpDiscovery).toBe(true)
  expect(shipped.worktree?.plugins?.[0]?.type).toBe('local')
  expect(shipped.worktree?.plugins?.[0]?.path).toContain(`/${SLUG}/plugin`)
})

test('the docker skill env reaches the session: project id and API base', () => {
  const env = shipped.worktree?.agentooEnv ?? {}
  expect(env.AGENTOO_PROJECT_ID).toBe('44444444-4444-4444-8444-444444444444')
  // apiBaseUrl rewrote the 0.0.0.0 bind to a dialable host.
  expect(env.AGENTOO_API_BASE).toBe('http://127.0.0.1:8000/api')
  expect(env.AGENTOO_PROJECT_SLUG).toBe(SLUG)
})

// --- Seam 6 --------------------------------------------------------------

test('a worktree session gets AGENTOO_SCOPE=worktree and its own AGENTOO_SESSION_ID', () => {
  expect(shipped.worktree?.agentooEnv.AGENTOO_SCOPE).toBe('worktree')
  expect(shipped.worktree?.hasSessionIdKey).toBe(true)
  expect(shipped.worktree?.agentooEnv.AGENTOO_SESSION_ID).toBe(
    '33333333-3333-4333-8333-333333333333',
  )
})

test('a repo-scope session has no AGENTOO_SESSION_ID key at all — not an empty string', () => {
  // Run under STALE_ENV, so this is a real claim: a truthy
  // AGENTOO_SESSION_ID was present in the process env and had to be removed,
  // not merely never set.
  expect(shipped.repo?.agentooEnv.AGENTOO_SCOPE).toBe('repo')
  // The load-bearing assertion: `''` would still satisfy the docker skill's
  // `sessionId ? ... : ''` check in the wrong direction only if it were
  // truthy, but it would satisfy a compose file's `${AGENTOO_SESSION_ID:?}`
  // and would break `[ -n "$AGENTOO_SESSION_ID" ]`-style rules elsewhere.
  expect(shipped.repo?.hasSessionIdKey).toBe(false)
  expect(shipped.repo?.agentooEnv.AGENTOO_SESSION_ID).toBeUndefined()
})

// --- inherited AGENTOO_* from a self-hosting box -------------------------
//
// `optionsFor` builds its env as `{ ...process.env, ...composeEnvFor(ref) }`.
// `composeEnvFor` *omits* AGENTOO_SESSION_ID at repo scope — but an omitted
// key in a spread is skipped, not deleted, so whatever `...process.env`
// already supplied survives. On this box that is not hypothetical: the worker
// assembling these options is itself running inside a session and carries all
// sixteen AGENTOO_* variables. A repo-scope session could therefore inherit
// *another session's* id, and the docker skill's rule — "send
// ?sessionId=$AGENTOO_SESSION_ID iff it is set" — would then aim a `down` or
// a `stop` at that other session's worktree.

test('a stale inherited AGENTOO_SESSION_ID does not survive into a repo-scope session', () => {
  const env = shipped.repo?.agentooEnv ?? {}
  expect(STALE_ENV.AGENTOO_SESSION_ID).toBeDefined()
  expect(shipped.repo?.hasSessionIdKey).toBe(false)
  expect(env.AGENTOO_SESSION_ID).toBeUndefined()
  // Specifically not the other session's id — the failure that would send a
  // mutation at someone else's worktree.
  expect(Object.values(env)).not.toContain(STALE_ENV.AGENTOO_SESSION_ID)
})

test('a stale inherited AGENTOO_SCOPE=worktree does not make a repo-scope session lie', () => {
  expect(STALE_ENV.AGENTOO_SCOPE).toBe('worktree')
  expect(shipped.repo?.agentooEnv.AGENTOO_SCOPE).toBe('repo')
})

test('stale inherited ports are replaced by this scope\'s own derivation, not kept', () => {
  const env = shipped.repo?.agentooEnv ?? {}
  const expected = expectedScopeEnv(null)
  for (let i = 0; i < 10; i++) {
    const key = `AGENTOO_PORT_${i}`
    expect(env[key]).toBe(expected[key] as string)
    // The stale value was there to be inherited and is gone.
    expect(env[key]).not.toBe(STALE_ENV[key])
  }
  expect(env.AGENTOO_COMPOSE_PROJECT).toBe(expected.AGENTOO_COMPOSE_PROJECT as string)
  expect(env.AGENTOO_PROJECT_SLUG).toBe(SLUG)
})

test('a worktree session under the same pollution gets its own id and fresh ports', () => {
  const env = shipped.worktree?.agentooEnv ?? {}
  const expected = expectedScopeEnv(SESSION_ID)
  expect(env.AGENTOO_SESSION_ID).toBe(SESSION_ID)
  expect(env.AGENTOO_SESSION_ID).not.toBe(STALE_ENV.AGENTOO_SESSION_ID)
  expect(env.AGENTOO_SCOPE).toBe('worktree')
  for (let i = 0; i < 10; i++) {
    const key = `AGENTOO_PORT_${i}`
    expect(env[key]).toBe(expected[key] as string)
    expect(env[key]).not.toBe(STALE_ENV[key])
  }
})

test('the whole AGENTOO_* surface is exactly composeEnvFor plus the two optionsFor sets', () => {
  // The strongest form, and the one that covers keys nobody has invented yet:
  // an exact set comparison, so a stale AGENTOO_* of *any* name surviving
  // fails here. STALE_ENV carries AGENTOO_FUTURE_KEY precisely to exercise
  // that — a hardcoded deny-list in `optionsFor` would leave it behind, while
  // deriving the authoritative set from composeEnvFor's own return value
  // removes it.
  expect(STALE_ENV.AGENTOO_FUTURE_KEY).toBeDefined()

  for (const [label, sessionId] of [
    ['repo', null],
    ['worktree', SESSION_ID],
  ] as const) {
    const env = shipped[label]?.agentooEnv ?? {}
    const want = { ...expectedScopeEnv(sessionId), AGENTOO_PROJECT_ID: '', AGENTOO_API_BASE: '' }
    expect(Object.keys(env).sort()).toEqual(Object.keys(want).sort())
    expect(env.AGENTOO_FUTURE_KEY).toBeUndefined()
  }
})

test('AGENTOO_PROJECT_ID and AGENTOO_API_BASE survive the strip and beat stale values', () => {
  // The over-broad-strip trap: both are AGENTOO_* keys that composeEnvFor
  // never emits, so a strip applied *after* they were set would delete the
  // two variables optionsFor itself just added — leaving the docker skill
  // with no API to call and no project to name. They must also win over the
  // stale inherited values, which is the other half of the ordering.
  for (const label of ['repo', 'worktree'] as const) {
    const env = shipped[label]?.agentooEnv ?? {}
    expect(env.AGENTOO_PROJECT_ID).toBe(PROJECT_ID)
    expect(env.AGENTOO_API_BASE).toBe('http://127.0.0.1:8000/api')
    expect(env.AGENTOO_PROJECT_ID).not.toBe(STALE_ENV.AGENTOO_PROJECT_ID)
    expect(env.AGENTOO_API_BASE).not.toBe(STALE_ENV.AGENTOO_API_BASE)
  }
})

test('a non-AGENTOO_ inherited variable is untouched — the strip is not a blanket wipe', () => {
  expect(shipped.repo?.unrelatedVar).toBe('must-survive')
  expect(shipped.worktree?.unrelatedVar).toBe('must-survive')
})

test('on a clean box with no AGENTOO_* to inherit, the same env comes out', async () => {
  // The fix must not *depend* on pollution being there, and must not invent
  // keys when it is not. Same assertions, empty ambient set.
  const clean = await runChild(['docker'], { pollution: {} })
  expect(clean.repo?.hasSessionIdKey).toBe(false)
  expect(clean.repo?.agentooEnv).toEqual({
    ...expectedScopeEnv(null),
    AGENTOO_PROJECT_ID: PROJECT_ID,
    AGENTOO_API_BASE: 'http://127.0.0.1:8000/api',
  })
  expect(clean.worktree?.agentooEnv).toEqual({
    ...expectedScopeEnv(SESSION_ID),
    AGENTOO_PROJECT_ID: PROJECT_ID,
    AGENTOO_API_BASE: 'http://127.0.0.1:8000/api',
  })
})

test('repo scope runs in the project checkout, worktree scope in the worktree', () => {
  expect(shipped.repo?.cwd).toContain(`/${SLUG}/repo`)
  expect(shipped.worktree?.cwd).toBe('/tmp/agentoo-test-worktree')
})

// --- a project with no MCP-declaring skill -------------------------------

test('a plugin with only the docker skill sets no mcpServers key at all', async () => {
  const dockerOnly = await runChild(['docker'])
  expect(dockerOnly.worktree?.hasMcpServersKey).toBe(false)
  // The docker env is still injected — it needs no MCP server.
  expect(dockerOnly.worktree?.agentooEnv.AGENTOO_API_BASE).toBe('http://127.0.0.1:8000/api')
})

test('a plugin with no skills directory contents sets no mcpServers key', async () => {
  const none = await runChild([])
  expect(none.worktree?.hasMcpServersKey).toBe(false)
  expect(none.worktree?.strictMcpConfig).toBe(true)
})


// --- apiBaseUrl and IPv6 literals ----------------------------------------
//
// BACKEND_HOST is a *bind* address and may legitimately be an IPv6 literal —
// this app is tailnet-first, where an `fd7a:...` bind is ordinary. RFC 3986's
// authority grammar only permits a bare ':' inside brackets, so an
// unbracketed literal made `new URL(...)` read the first ':' as the port
// separator and throw; every session then got an AGENTOO_API_BASE the docker
// skill could not dial at all. These run through the real optionsFor, so they
// cover env.ts's rewrite *and* the fact that the result is what lands in the
// session's environment.

test('an IPv6 literal BACKEND_HOST is bracketed, so AGENTOO_API_BASE is a usable URL', async () => {
  const ipv6 = await runChild([], { backendHost: '::1' })
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[::1]:8000/api')
  // The assertion that actually matters: a request the skill builds from it
  // parses. Unbracketed, this threw.
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
  expect(new URL(`${base}/projects/x/docker`).hostname).toBe('[::1]')
  expect(new URL(`${base}/projects/x/docker`).port).toBe('8000')
})

test('a routable IPv6 bind (the tailnet case) is bracketed too, not just loopback', async () => {
  const ipv6 = await runChild([], { backendHost: 'fd7a:115c:a1e0::1' })
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[fd7a:115c:a1e0::1]:8000/api')
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
})

test('an already-bracketed BACKEND_HOST is not bracketed a second time', async () => {
  // The obvious way to get this wrong: `[[::1]]`, which is not a URL either.
  const ipv6 = await runChild([], { backendHost: '[::1]' })
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[::1]:8000/api')
  expect(base).not.toContain('[[')
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
})

test('a hostname BACKEND_HOST is passed through unbracketed', async () => {
  // Nothing without a ':' may be touched — bracketing a hostname would break
  // every ordinary deployment to fix the exotic one.
  const named = await runChild([], { backendHost: 'api.internal' })
  expect(named.worktree?.agentooEnv.AGENTOO_API_BASE).toBe('http://api.internal:8000/api')
})

test('the wildcard binds still rewrite to loopback, and stay unbracketed', async () => {
  // The pre-existing behaviour the bracket fix sits on top of: '::' is a
  // wildcard bind, so it becomes 127.0.0.1 *before* the bracket check and
  // must not come out as `[::]`.
  const v6wildcard = await runChild([], { backendHost: '::' })
  expect(v6wildcard.worktree?.agentooEnv.AGENTOO_API_BASE).toBe('http://127.0.0.1:8000/api')
  expect(v6wildcard.worktree?.agentooEnv.AGENTOO_API_BASE).not.toContain('[')
})
