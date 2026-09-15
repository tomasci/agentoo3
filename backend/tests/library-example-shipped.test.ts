// The *shipped* library (library.example/) read by the *real* readers.
//
// Every other test in this suite builds its own fixtures, so nothing had ever
// pointed skillMcpServers at library.example/skills/browser/mcp.json or
// listAgents at library.example/agents. Both are files an operator's box gets
// verbatim, and both fail silently when they are wrong: a skill whose mcp.json
// does not satisfy the reader's schema contributes no tools, and an agent
// whose frontmatter does not parse is skipped at session time with only a log
// line.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import './setup-env'

const { skillMcpServers } = await import('../src/library/mcp')
const { listAgents } = await import('../src/library/index')
const { agentFrontmatterSchema, checkLibraryName } = await import('../src/library/types')
const { logger } = await import('../src/lib/logger')

const LIBRARY = join(import.meta.dir, '..', '..', 'library.example')
const SKILLS = join(LIBRARY, 'skills')
const AGENTS = join(LIBRARY, 'agents')

/** Every logger.warn emitted while `fn` ran. A warning from these readers is
 * the *only* signal an operator gets that a shipped file was skipped, so
 * "produced no warning" is the assertion, not a nice-to-have. */
let warnings: string[] = []
let restoreWarn: (() => void) | null = null

beforeEach(() => {
  warnings = []
  const original = logger.warn.bind(logger)
  logger.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }) as typeof logger.warn
  restoreWarn = () => {
    logger.warn = original
  }
})

afterEach(() => {
  restoreWarn?.()
  restoreWarn = null
})

// --- Seam 1: the shipped mcp.json against the shipped reader ---------------

test('the shipped skills directory yields exactly the playwright server, no warnings', async () => {
  const servers = await skillMcpServers(SKILLS)

  expect(servers).toEqual({
    playwright: {
      command: 'playwright-mcp',
      // `chromium`, not `chrome`: the latter is Playwright's branded Google
      // Chrome channel, which the installer never puts on the box. That
      // coupling is owned by browser-skill-contract.test.ts; this literal is
      // here so the reader of *this* file sees the exact argv a session gets.
      args: ['--headless', '--isolated', '--browser', 'chromium', '--viewport-size', '1280x720'],
    },
  })
  expect(warnings).toEqual([])
})

test('the docker skill ships no mcp.json, and that is silent, not a warning', async () => {
  const files = await readdir(join(SKILLS, 'docker'))
  expect(files).not.toContain('mcp.json')
  await skillMcpServers(SKILLS)
  expect(warnings).toEqual([])
})

test('every shipped skill directory name is a legal library name', async () => {
  const entries = await readdir(SKILLS, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  expect(dirs.sort()).toEqual(['browser', 'docker', 'project-conventions'])
  for (const name of dirs) expect(checkLibraryName(name)).toEqual({ ok: true })
})

test('the shipped MCP server name is legal, so its tools get a usable mcp__ prefix', async () => {
  const servers = await skillMcpServers(SKILLS)
  for (const name of Object.keys(servers)) {
    expect(checkLibraryName(name)).toEqual({ ok: true })
    // What the SDK will actually call, and what SKILL.md documents.
    expect(`mcp__${name}__browser_navigate`).toBe('mcp__playwright__browser_navigate')
  }
})

// --- SKILL.md frontmatter: only name + description survives updateSkill ----

test('every shipped SKILL.md carries only `name` and `description` in frontmatter', async () => {
  const entries = await readdir(SKILLS, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS, entry.name, 'SKILL.md')
    const { data } = matter(await readFile(file, 'utf8'))
    // Anything else here is destroyed the first time an operator saves the
    // skill in the library UI (skillToMarkdown only emits these two).
    expect(Object.keys(data).sort()).toEqual(['description', 'name'])
    // And `name` must match the directory, which is the real identity.
    expect(data.name).toBe(entry.name)
    expect(typeof data.description).toBe('string')
    expect((data.description as string).length).toBeGreaterThan(0)
  }
})

// --- Seam 3: does the shipped tester agent still load? --------------------

test('listAgents on the shipped agents dir returns every file, with no warnings', async () => {
  const agents = await listAgents(AGENTS)
  const onDisk = (await readdir(AGENTS)).filter((f) => f.endsWith('.md')).sort()

  expect(agents.map((a) => `${a.name}.md`).sort()).toEqual(onDisk)
  // A file that fails to parse is skipped with a warning and then silently
  // missing from every session that assigned it.
  expect(warnings).toEqual([])
})

test('the shipped tester parses, and its disallowedTools reach the frontmatter', async () => {
  const agents = await listAgents(AGENTS)
  const tester = agents.find((a) => a.name === 'tester')

  expect(tester).toBeDefined()
  expect(tester?.role).toBe('subagent')
  expect(tester?.disallowedTools).toEqual([
    'Task',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'TodoWrite',
  ])
  // `tools` was removed on purpose: an allowlist there would have excluded the
  // mcp__playwright__* tools the browser skill adds.
  expect(tester?.tools).toBeUndefined()
  expect(tester?.model).toBe('opus')
  expect(tester?.effort).toBe('high')
  expect(tester?.prompt.length).toBeGreaterThan(0)
})

test('every shipped agent file validates against agentFrontmatterSchema directly', async () => {
  const files = (await readdir(AGENTS)).filter((f) => f.endsWith('.md'))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const { data } = matter(await readFile(join(AGENTS, file), 'utf8'))
    const parsed = agentFrontmatterSchema.safeParse(data)
    if (!parsed.success) {
      throw new Error(`${file} failed agentFrontmatterSchema: ${JSON.stringify(parsed.error.issues)}`)
    }
    expect(parsed.success).toBe(true)
  }
})

test('the shipped tester is a subagent, so it is offered on the roster, not as a lead', async () => {
  const { subagents, orchestrators } = await import('../src/library/index')
  const agents = await listAgents(AGENTS)
  expect(subagents(agents).map((a) => a.name)).toContain('tester')
  expect(orchestrators(agents).map((a) => a.name)).not.toContain('tester')
})

// --- ${CLAUDE_SKILL_DIR} and the files it has to resolve against ----------
//
// Verified directly against the shipped CLI
// (@anthropic-ai/claude-agent-sdk-linux-x64/claude): the plugin-skill branch
// does `U = LT(t.filePath)` — the skill's own directory — and then
// `if (y.isSkillMode) lt = lt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, U)` on the
// body, after the `Base directory for this skill: <path>` prefix. So the
// substitution is real and the placeholder is the correct way to name a
// sibling file. What is *not* guaranteed by the CLI, and is what these pin,
// is the repo side: that the placeholder is used consistently, quoted, and
// that the file it names actually travels beside SKILL.md.

test('every docker.ts invocation in SKILL.md goes through ${CLAUDE_SKILL_DIR}, quoted', async () => {
  const text = await readFile(join(SKILLS, 'docker', 'SKILL.md'), 'utf8')
  const invocations = [...text.matchAll(/^\s*bun\s+(\S+)/gm)].map((m) => m[1] as string)

  expect(invocations.length).toBeGreaterThan(0)
  for (const target of invocations) {
    // Quoted: a plugin directory path is built from PROJECTS_DIR and a slug,
    // and an unquoted expansion would word-split on the first space in it.
    expect(target).toBe('"${CLAUDE_SKILL_DIR}/docker.ts"')
  }
  // No relative or absolute path smuggled in alongside. `cwd` for a Bash tool
  // call is the repo checkout, never the plugin directory, so `./docker.ts`
  // and `docker.ts` both resolve to nothing.
  expect(text).not.toContain('bun ./docker.ts')
  expect(text).not.toContain('bun docker.ts')
})

test('the file ${CLAUDE_SKILL_DIR} is used to reach actually sits beside SKILL.md', async () => {
  // The placeholder resolves to the skill's own directory, so the script has
  // to be a sibling of SKILL.md — which is also exactly what `materialise`'s
  // `cp -r` of the whole directory delivers into a project's plugin folder.
  const files = await readdir(join(SKILLS, 'docker'))
  expect(files.sort()).toEqual(['SKILL.md', 'docker.ts'])
})

test('the browser skill names no script, so it needs no ${CLAUDE_SKILL_DIR}', async () => {
  // Its capability arrives as MCP tools, not as a file to execute. A
  // `${CLAUDE_SKILL_DIR}` here would mean a sibling script nobody shipped.
  const text = await readFile(join(SKILLS, 'browser', 'SKILL.md'), 'utf8')
  expect(text).not.toContain('CLAUDE_SKILL_DIR')
  const files = await readdir(join(SKILLS, 'browser'))
  expect(files.sort()).toEqual(['SKILL.md', 'mcp.json'])
})
