import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

// `@/library` reaches `@/env` for the default agents directory, which has to be
// parsed before anything else imports it. See the note in setup-env.
import './setup-env'

const { listAgents, subagents } = await import('../src/library/index')

const agent = (role: string, description: string, body = 'Do the thing.') =>
  `---\nrole: ${role}\ndescription: ${description}\n---\n\n${body}\n`

async function pluginDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentoo-roster-'))
  await writeFile(join(dir, 'tester.md'), agent('subagent', 'Runs the change.'))
  await writeFile(join(dir, 'lead.md'), agent('orchestrator', 'Drives a session.'))
  // No frontmatter role at all: the schema defaults it to subagent, so this is a
  // delegation target like any other rather than a file that quietly vanishes.
  await writeFile(join(dir, 'scout.md'), `---\ndescription: Reads things.\n---\n\nLook.\n`)
  // Not an agent. A stray file in the directory must not become a roster line.
  await writeFile(join(dir, 'notes.txt'), 'ignore me')
  return dir
}

test('the roster is read from a project plugin directory, not only from the library', async () => {
  const found = await listAgents(await pluginDir())
  expect(found.map((a) => a.name).sort()).toEqual(['lead', 'scout', 'tester'])
  // The filename is the identity, and the description is what routing uses.
  expect(found.find((a) => a.name === 'tester')?.description).toBe('Runs the change.')
})

test('only subagents are offered as specialists, so the lead is not its own teammate', async () => {
  const found = subagents(await listAgents(await pluginDir()))
  expect(found.map((a) => a.name).sort()).toEqual(['scout', 'tester'])
})

test('a project with nothing assigned reads as an empty roster, not a crash', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'agentoo-roster-empty-'))
  expect(await listAgents(empty)).toEqual([])
  // And a directory that was never created at all — a project whose plugin has
  // not been synced yet — is the same answer rather than a thrown ENOENT.
  expect(await listAgents(join(empty, 'agents'))).toEqual([])
})
