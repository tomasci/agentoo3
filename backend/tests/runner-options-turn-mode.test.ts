// What Q&A mode does to the SDK options, through the real `optionsFor` in a
// child process (runner-options-turn-mode-child.ts) — the same arrangement as
// runner-options-mcp.test.ts, for the same reason: the option assembly is the
// thing under test, and it needs four database- or checkout-bound modules faked
// around it.
//
// Two claims, and the second is the one that costs money if it breaks. Q&A turns
// the session read-only. And it does that without touching anything that would
// invalidate the prompt cache of the session's resumed context — `tools`,
// `disallowedTools`, `systemPrompt`, `model`, `resume` — which is why the main
// test below compares whole option sets and names the only differences allowed,
// instead of spot-checking a few keys.

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './setup-env'

const BACKEND = new URL('..', import.meta.url).pathname
const SLUG = 'demo'

const QA_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit'

interface Variant {
  options: Record<string, unknown> & {
    permissionMode?: string
    allowedTools?: string[]
    hooks: { PreToolUse: string[] }
  }
  keys: string[]
  qaHookVerdict: { hookSpecificOutput?: Record<string, unknown> } | null
}

async function runChild(): Promise<Record<string, Variant>> {
  const projects = await mkdtemp(join(tmpdir(), 'agentoo-runner-turn-mode-'))
  await mkdir(join(projects, SLUG, 'plugin', 'skills'), { recursive: true })
  await mkdir(join(projects, 'library', 'agents'), { recursive: true })
  // A solo orchestrator (`team: false`), so composing its prompt reads no other
  // library file; everything that matters here is in the frontmatter.
  await writeFile(
    join(projects, 'library', 'agents', 'lead.md'),
    [
      '---',
      'role: orchestrator',
      'team: false',
      'description: Lead used by the Q&A options test',
      'model: opus',
      'effort: high',
      'maxTurns: 12',
      'tools: [Read, Edit, Write, Bash, Grep]',
      'disallowedTools: [NotebookEdit]',
      '---',
      '',
      'You are the lead. Work carefully.',
      '',
    ].join('\n'),
  )

  // Ambient AGENTOO_* dropped so the run is the same on a box that self-hosts
  // this app — see runner-options-mcp.test.ts. Both modes run in one child and
  // are compared with each other, so nothing here depends on the rest.
  const ambient: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AGENTOO_') || value === undefined) continue
    ambient[key] = value
  }

  const proc = Bun.spawn(['bun', join(BACKEND, 'tests', 'runner-options-turn-mode-child.ts')], {
    cwd: BACKEND,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...ambient,
      PROJECTS_DIR: projects,
      LIBRARY_DIR: join(projects, 'library'),
      ATTACHMENTS_DIR: join(projects, 'attachments'),
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: '8000',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      REDIS_URL: 'redis://127.0.0.1:1',
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
  return JSON.parse(match[1]) as Record<string, Variant>
}

const facts = await runChild()
const SCENARIOS = ['none', 'attachments'] as const

/** The one variant a scenario/mode names; a missing one is a broken child, not a pass. */
const variant = (scenario: string, mode: 'code' | 'qa'): Variant => {
  const found = facts[`${scenario}:${mode}`]
  if (!found) throw new Error(`child printed no ${scenario}:${mode}`)
  return found
}

test('Code keeps bypassPermissions, no allowedTools, and exactly the two hooks it had', () => {
  for (const scenario of SCENARIOS) {
    const { options, keys, qaHookVerdict } = variant(scenario, 'code')
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(keys).not.toContain('allowedTools')
    expect(options.allowedTools).toBeUndefined()
    // delegationHook, then attachmentsHook — nothing added, nothing reordered.
    expect(options.hooks.PreToolUse).toEqual([
      'Agent|Task',
      'Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit',
    ])
    expect(qaHookVerdict).toBeNull()
  }
})

test('Q&A runs under dontAsk with the read-only allow list and the extra PreToolUse hook', () => {
  for (const scenario of SCENARIOS) {
    const { options, qaHookVerdict } = variant(scenario, 'qa')
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch',
      'Agent',
      'Task',
      'TodoWrite',
      'Skill',
      'ToolSearch',
    ])
    // After the two Code hooks, which stay where they were.
    expect(options.hooks.PreToolUse).toEqual([
      'Agent|Task',
      'Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit',
      QA_MATCHER,
    ])
    // And the registered hook is the real one: it refuses a Write.
    expect(qaHookVerdict?.hookSpecificOutput?.permissionDecision).toBe('deny')
  }
})

test('nothing else differs between Code and Q&A for the same session', () => {
  // Whole option sets, minus exactly the three things Q&A is allowed to change.
  // Anything that would invalidate the prompt cache of a long session's context
  // (tools, disallowedTools, systemPrompt, model, resume) or loosen the
  // attachments rules (settings) would show up here as a difference.
  for (const scenario of SCENARIOS) {
    const code = variant(scenario, 'code')
    const qa = variant(scenario, 'qa')

    const stripped = (v: Variant) => {
      const { permissionMode, allowedTools, hooks, ...rest } = v.options
      return { ...rest, preToolUse: hooks.PreToolUse.filter((m) => m !== QA_MATCHER) }
    }
    expect(stripped(qa)).toEqual(stripped(code))
    expect(qa.keys.filter((k) => k !== 'allowedTools')).toEqual(code.keys)
  }
})

test('the things that decide the prompt cache are present, and the same, in both modes', () => {
  // The previous test proves "no difference"; this one proves the comparison
  // was not vacuous — each of these actually exists on the options it compared.
  for (const scenario of SCENARIOS) {
    const code = variant(scenario, 'code').options
    const qa = variant(scenario, 'qa').options

    expect(code.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep'])
    expect(code.disallowedTools).toEqual(['NotebookEdit'])
    expect(code.model).toBe('opus')
    expect(code.resume).toBe('sdk-session-under-test')
    expect(typeof code.systemPrompt === 'string' || Array.isArray(code.systemPrompt)).toBe(true)

    for (const key of ['tools', 'disallowedTools', 'systemPrompt', 'model', 'effort', 'resume']) {
      expect(qa[key], key).toEqual(code[key])
    }
  }
})

test('Q&A adds no blanket deny rule: the attachments rules are the only ones, in both modes', () => {
  // A broader `settings.permissions.deny` would be a second way to enforce
  // read-only, and one the model sees in its prompt; the decision is that the
  // permission mode, the allow list and the hook do it instead.
  for (const mode of ['code', 'qa'] as const) {
    const none = variant('none', mode).options.settings as { permissions: { deny: string[] } }
    const some = variant('attachments', mode).options.settings as { permissions: { deny: string[] } }
    expect(none.permissions.deny).toHaveLength(3)
    expect(some.permissions.deny).toHaveLength(2)
    expect(none.permissions.deny.filter((rule) => !/^(Edit|Write|Read)\(/.test(rule))).toEqual([])
  }
})

test('a Code turn built right after a Q&A one is identical to a fresh Code turn', () => {
  // Options are rebuilt every turn; this pins that nothing from the Q&A build
  // (allow list, extra hook, permission mode) is carried into the next one.
  const fresh = variant('none', 'code')
  const after = facts['sequence:code-after-qa']
  if (!after) throw new Error('child printed no sequence:code-after-qa')
  expect(after.options).toEqual(fresh.options)
  expect(after.keys).toEqual(fresh.keys)
  expect(after.options.permissionMode).toBe('bypassPermissions')
  expect(after.options.allowedTools).toBeUndefined()
})

test('mutating one Q&A turn\'s options does not reach the next: each gets its own allow list and hooks', () => {
  const second = facts['sequence:qa-after-mutation']
  if (!second) throw new Error('child printed no sequence:qa-after-mutation')
  expect(second.options.allowedTools).toEqual(variant('none', 'qa').options.allowedTools)
  expect(second.options.allowedTools).not.toContain('Edit')
  expect(second.options.hooks.PreToolUse).toEqual([
    'Agent|Task',
    'Read|Grep|Glob|Bash|Edit|Write|NotebookRead|NotebookEdit',
    QA_MATCHER,
  ])
})
