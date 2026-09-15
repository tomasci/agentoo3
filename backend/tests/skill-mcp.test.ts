import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

// `@/library/mcp` reaches `@/lib/logger`, which reaches `@/env` — see the note
// in setup-env for why this has to come first.
import './setup-env'

const { skillMcpServers, SKILL_MCP_FILE } = await import('../src/library/mcp')
const { apiBaseUrl } = await import('../src/env')

/** A scratch `skills/` directory, empty, ready for individual tests to populate. */
async function skillsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentoo-skill-mcp-'))
}

async function writeSkill(
  skillsRoot: string,
  name: string,
  mcpJsonContents: string,
): Promise<void> {
  const dir = join(skillsRoot, name)
  await mkdir(dir, { recursive: true })
  // SKILL.md is not required here: this function reads siblings of it, but
  // does not itself gate on the skill being well-formed — that is
  // listSkills'/materialise's job, upstream of this one.
  await writeFile(join(dir, SKILL_MCP_FILE), mcpJsonContents, 'utf8')
}

test('a skill dir with a valid mcp.json contributes its server', async () => {
  const dir = await skillsDir()
  await writeSkill(
    dir,
    'browser',
    JSON.stringify({
      mcpServers: { playwright: { command: 'playwright-mcp', args: ['--headless'] } },
    }),
  )

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ playwright: { command: 'playwright-mcp', args: ['--headless'] } })
})

test('a skill dir with no mcp.json at all contributes nothing, and does not throw', async () => {
  const dir = await skillsDir()
  await mkdir(join(dir, 'docker'), { recursive: true })
  await writeFile(join(dir, 'docker', 'SKILL.md'), '---\ndescription: x\n---\n\nBody.\n', 'utf8')

  expect(await skillMcpServers(dir)).toEqual({})
})

test('a directory that was never created at all reads as no servers, not ENOENT', async () => {
  const dir = await skillsDir()
  expect(await skillMcpServers(join(dir, 'skills'))).toEqual({})
})

test('malformed JSON in one skill is skipped and warned, but another skill still loads', async () => {
  const dir = await skillsDir()
  await writeSkill(dir, 'broken', '{ not valid json')
  await writeSkill(
    dir,
    'ok',
    JSON.stringify({ mcpServers: { good: { command: 'good-mcp' } } }),
  )

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ good: { command: 'good-mcp' } })
})

test('a file that parses as JSON but not as { mcpServers } is skipped, not fatal', async () => {
  const dir = await skillsDir()
  // Valid JSON, wrong shape entirely: no `mcpServers` key at all.
  await writeSkill(dir, 'shapeless', JSON.stringify({ servers: { x: { command: 'x' } } }))
  await writeSkill(dir, 'ok', JSON.stringify({ mcpServers: { good: { command: 'good-mcp' } } }))

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ good: { command: 'good-mcp' } })
})

test('an http/url server entry is rejected; a stdio sibling in the same file still loads', async () => {
  const dir = await skillsDir()
  await writeSkill(
    dir,
    'mixed',
    JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://example.com/mcp' },
        'bare-url': { url: 'https://example.com/mcp' },
        local: { command: 'local-mcp' },
      },
    }),
  )

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ local: { command: 'local-mcp' } })
})

test('an invalid server name is rejected — it would become part of a tool call name', async () => {
  const dir = await skillsDir()
  await writeSkill(
    dir,
    'naming',
    JSON.stringify({
      mcpServers: {
        'mcp__evil': { command: 'evil-mcp' },
        fine: { command: 'fine-mcp' },
      },
    }),
  )

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ fine: { command: 'fine-mcp' } })
})

test('two skills declaring the same server name: the first in directory order wins, no throw', async () => {
  const dir = await skillsDir()
  // Names chosen so alphabetical order (what skillMcpServers sorts on) is
  // unambiguous: "skill-a" before "skill-b".
  await writeSkill(
    dir,
    'skill-a',
    JSON.stringify({ mcpServers: { shared: { command: 'from-a' } } }),
  )
  await writeSkill(
    dir,
    'skill-b',
    JSON.stringify({ mcpServers: { shared: { command: 'from-b' } } }),
  )

  const servers = await skillMcpServers(dir)
  expect(servers).toEqual({ shared: { command: 'from-a' } })
})

// --- apiBaseUrl's wildcard-bind rewrite -----------------------------------
//
// BACKEND_HOST is parsed once, at `@/env`'s first import, and the shared test
// process has already fixed it (implicitly, to the schema default) by the
// time this file runs — see setup-env's own note on why. So this runs each
// case in its own child process, exactly like docker-compose-env.test.ts's
// "deterministic across a separate process" check, rather than trying to
// mutate `process.env.BACKEND_HOST` after the fact and hoping it is still
// read.

async function apiBaseUrlWith(host: string): Promise<string> {
  const script = `
    import { apiBaseUrl } from ${JSON.stringify(new URL('../src/env.ts', import.meta.url).pathname)}
    console.log(apiBaseUrl())
  `
  const proc = Bun.spawn(['bun', 'run', '-'], {
    stdin: new TextEncoder().encode(script),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      BACKEND_HOST: host,
      BACKEND_PORT: '8000',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`child exited ${code}: ${err}`)
  return out.trim()
}

test('a wildcard bind (0.0.0.0) is dialled at 127.0.0.1, not the literal bind address', async () => {
  expect(await apiBaseUrlWith('0.0.0.0')).toBe('http://127.0.0.1:8000/api')
})

test('the IPv6 wildcard bind (::) is dialled at 127.0.0.1 too', async () => {
  expect(await apiBaseUrlWith('::')).toBe('http://127.0.0.1:8000/api')
})

test('an empty BACKEND_HOST is dialled at 127.0.0.1', async () => {
  expect(await apiBaseUrlWith('')).toBe('http://127.0.0.1:8000/api')
})

test('an ordinary, non-wildcard host is passed straight through unchanged', async () => {
  expect(await apiBaseUrlWith('127.0.0.1')).toBe('http://127.0.0.1:8000/api')
})

// `apiBaseUrl` is also imported directly (above) so a typecheck regression on
// its signature would be caught even if every subprocess test above were
// skipped for some environmental reason.
test('apiBaseUrl is a function returning a string', () => {
  expect(typeof apiBaseUrl).toBe('function')
  expect(typeof apiBaseUrl()).toBe('string')
})
