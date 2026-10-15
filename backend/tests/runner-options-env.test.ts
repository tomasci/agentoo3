// A session's environment carries none of this app's own database or Redis
// credentials — the fix for the night every project, session and message row
// was deleted. A security-audit subagent ran a PoC that imported
// `@/db/client` and called `db.delete(projects)`; it had exported a scratch
// DATABASE_URL in an earlier Bash call, env does not survive between calls,
// and the run that mattered used the one `optionsFor` had copied out of the
// worker's own `process.env`: the live database.
//
// Run through the real `optionsFor` in a child process
// (runner-options-env-child.ts), with every canary from app-credentials.ts in
// that child's own env — so "absent from the session" is a real claim, not
// the product of a test box that simply never had them set. The parent drops
// its own copies of those names first, so a developer shell holding the real
// values cannot hand them to the child either.

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './setup-env'
import { composeEnvFor } from '../src/features/docker/compose-env'
import { APP_CREDENTIAL_VARS } from '../src/lib/child-env'
import { CANARY_CREDENTIALS, CLAUDE_CREDENTIALS, REQUIRED_SCRUBBED } from './app-credentials'

const BACKEND = new URL('..', import.meta.url).pathname
const SLUG = 'demo'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const PROJECT_ID = '66666666-6666-4666-8666-666666666666'

interface ScopeFacts {
  keys: string[]
  present: string[]
  leaked: string[]
  claude: Record<string, string | undefined>
  agentooEnv: Record<string, string>
  unrelatedVar: string | null
  hasPath: boolean
}

async function runChild(): Promise<Record<'repo' | 'worktree', ScopeFacts>> {
  const projects = await mkdtemp(join(tmpdir(), 'agentoo-runner-env-'))
  await mkdir(join(projects, SLUG, 'plugin', 'skills'), { recursive: true })

  const ambient: Record<string, string> = {}
  const scrubbed = new Set<string>([...REQUIRED_SCRUBBED, ...APP_CREDENTIAL_VARS])
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('AGENTOO_') || scrubbed.has(key)) continue
    ambient[key] = value
  }

  const proc = Bun.spawn(['bun', join(BACKEND, 'tests', 'runner-options-env-child.ts')], {
    cwd: BACKEND,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...ambient,
      ...CANARY_CREDENTIALS,
      ...CLAUDE_CREDENTIALS,
      UNRELATED_TEST_VAR: 'must-survive',
      PROJECTS_DIR: projects,
      LIBRARY_DIR: join(projects, 'library'),
      ATTACHMENTS_DIR: join(projects, 'attachments'),
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: '8000',
      LOG_LEVEL: '1',
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
  return JSON.parse(match[1]) as Record<'repo' | 'worktree', ScopeFacts>
}

const facts = await runChild()
const SCOPES = ['repo', 'worktree'] as const

test('no database or Redis variable reaches the session env, though the worker had all of them', () => {
  for (const scope of SCOPES) {
    expect(facts[scope].present).toEqual([])
    for (const key of REQUIRED_SCRUBBED) expect(facts[scope].keys).not.toContain(key)
  }
})

test('no canary value reaches the session env under any name', () => {
  for (const scope of SCOPES) expect(facts[scope].leaked).toEqual([])
})

test('the Claude credentials still reach the session, unchanged', () => {
  for (const scope of SCOPES) {
    expect(facts[scope].claude).toEqual(CLAUDE_CREDENTIALS)
  }
})

test('the AGENTOO_* block is still exactly what composeEnvFor emits, plus project id and API base', () => {
  for (const [scope, sessionId] of [
    ['repo', null],
    ['worktree', SESSION_ID],
  ] as const) {
    expect(facts[scope].agentooEnv).toEqual({
      ...composeEnvFor({ slug: SLUG, sessionId }),
      AGENTOO_PROJECT_ID: PROJECT_ID,
      AGENTOO_API_BASE: 'http://127.0.0.1:8000/api',
    })
  }
})

test('the scrub is not a blanket wipe: PATH and an unrelated variable survive', () => {
  for (const scope of SCOPES) {
    expect(facts[scope].hasPath).toBe(true)
    expect(facts[scope].unrelatedVar).toBe('must-survive')
  }
})
