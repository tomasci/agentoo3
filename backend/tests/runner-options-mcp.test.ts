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

import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import './setup-env'

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
  }
}

/** A projects root with `demo/plugin/skills/` populated from `seedSkills`. */
async function runChild(seedSkills: string[], backendHost = '0.0.0.0'): Promise<Facts> {
  const projects = await mkdtemp(join(tmpdir(), 'agentoo-runner-options-'))
  const skillsDir = join(projects, SLUG, 'plugin', 'skills')
  await mkdir(skillsDir, { recursive: true })
  for (const name of seedSkills) {
    await cp(join(REPO, 'library.example', 'skills', name), join(skillsDir, name), {
      recursive: true,
    })
  }

  const proc = Bun.spawn(['bun', join(BACKEND, 'tests', 'runner-options-mcp-child.ts')], {
    cwd: BACKEND,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
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

const shipped = await runChild(['browser', 'docker'])

test('the shipped browser skill in a project plugin dir becomes Options.mcpServers', () => {
  expect(shipped.worktree?.mcpServers).toEqual({
    playwright: {
      command: 'playwright-mcp',
      // The argv reaches the SDK verbatim — including `chromium`, the browser
      // 57-install-playwright.sh actually installs (see
      // browser-skill-contract.test.ts for that coupling).
      args: ['--headless', '--isolated', '--browser', 'chromium', '--viewport-size', '1280x720'],
    },
  })
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
  expect(shipped.repo?.agentooEnv.AGENTOO_SCOPE).toBe('repo')
  // The load-bearing assertion: `''` would still satisfy the docker skill's
  // `sessionId ? ... : ''` check in the wrong direction only if it were
  // truthy, but it would satisfy a compose file's `${AGENTOO_SESSION_ID:?}`
  // and would break `[ -n "$AGENTOO_SESSION_ID" ]`-style rules elsewhere.
  expect(shipped.repo?.hasSessionIdKey).toBe(false)
  expect(shipped.repo?.agentooEnv.AGENTOO_SESSION_ID).toBeUndefined()
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
  const ipv6 = await runChild([], '::1')
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[::1]:8000/api')
  // The assertion that actually matters: a request the skill builds from it
  // parses. Unbracketed, this threw.
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
  expect(new URL(`${base}/projects/x/docker`).hostname).toBe('[::1]')
  expect(new URL(`${base}/projects/x/docker`).port).toBe('8000')
})

test('a routable IPv6 bind (the tailnet case) is bracketed too, not just loopback', async () => {
  const ipv6 = await runChild([], 'fd7a:115c:a1e0::1')
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[fd7a:115c:a1e0::1]:8000/api')
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
})

test('an already-bracketed BACKEND_HOST is not bracketed a second time', async () => {
  // The obvious way to get this wrong: `[[::1]]`, which is not a URL either.
  const ipv6 = await runChild([], '[::1]')
  const base = ipv6.worktree?.agentooEnv.AGENTOO_API_BASE
  expect(base).toBe('http://[::1]:8000/api')
  expect(base).not.toContain('[[')
  expect(() => new URL(`${base}/projects/x/docker`)).not.toThrow()
})

test('a hostname BACKEND_HOST is passed through unbracketed', async () => {
  // Nothing without a ':' may be touched — bracketing a hostname would break
  // every ordinary deployment to fix the exotic one.
  const named = await runChild([], 'api.internal')
  expect(named.worktree?.agentooEnv.AGENTOO_API_BASE).toBe('http://api.internal:8000/api')
})

test('the wildcard binds still rewrite to loopback, and stay unbracketed', async () => {
  // The pre-existing behaviour the bracket fix sits on top of: '::' is a
  // wildcard bind, so it becomes 127.0.0.1 *before* the bracket check and
  // must not come out as `[::]`.
  const v6wildcard = await runChild([], '::')
  expect(v6wildcard.worktree?.agentooEnv.AGENTOO_API_BASE).toBe('http://127.0.0.1:8000/api')
  expect(v6wildcard.worktree?.agentooEnv.AGENTOO_API_BASE).not.toContain('[')
})
