import { expect, test } from 'bun:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './setup-env'

const dir = await mkdtemp(join(tmpdir(), 'agentoo-keys-'))
process.env.SSH_KEYS_DIR = dir

const { keyProblem, privateKeyPath, testKey, SSH_KEYS_DIR } = await import('../src/lib/ssh')

test('key paths come from the configured directory, not from $HOME', () => {
  // The bug this guards: the fallback is homedir()/.ssh/agentoo, so keys written
  // while the services ran as root landed in /root/.ssh and became unreadable
  // once those services moved to a service account.
  expect(SSH_KEYS_DIR).toBe(dir)
  expect(privateKeyPath('github')).toBe(join(dir, 'github'))
  expect(privateKeyPath('github')).not.toContain('/root/')
})

test('a readable key reports no problem', async () => {
  const path = join(dir, 'good')
  await writeFile(path, 'not really a key\n')
  await chmod(path, 0o600)
  expect(await keyProblem(path)).toBeUndefined()
})

test('a missing key says it is missing, and names the setting', async () => {
  const problem = await keyProblem(join(dir, 'absent'))
  expect(problem).toContain('missing')
  expect(problem).toContain('SSH_KEYS_DIR')
})

test('an unreadable key says so rather than looking like a rejection', async () => {
  const path = join(dir, 'locked')
  await writeFile(path, 'not really a key\n')
  await chmod(path, 0o000)

  const problem = await keyProblem(path)
  expect(problem).toContain('not readable')
  // The point: ssh skips a key it cannot read in silence and the attempt ends
  // as "Permission denied (publickey)", which sends you to the host's deploy
  // keys to fix a local file permission.
  expect(problem).toContain('different user')

  const result = await testKey(path, 'github.com')
  expect(result.ok).toBe(false)
  expect(result.message).toContain('not readable')
  expect(result.message).not.toContain('deploy key')

  await chmod(path, 0o600)
})

test('a bad host is still rejected before anything is spawned', async () => {
  const result = await testKey(join(dir, 'good'), '-oProxyCommand=touch /tmp/pwned')
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/may not start with|must look like/)
})
