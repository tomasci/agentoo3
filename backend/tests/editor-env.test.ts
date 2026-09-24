// env.ts's EDITOR_* schema and `editorEnabled` — exercised via a real
// subprocess per case, not a mock: `editorEnabled` (like every other export
// in this module) is computed exactly once, from `process.env`, at module
// load — genuinely re-testing it for a second combination means genuinely
// re-booting the module, which only a fresh process actually does. The same
// reasoning applies to every EDITOR_* validator: `schema.safeParse(process.env)`
// runs once at import, so an invalid value has to be observed by asking a
// fresh process to fail loudly and exit(1), the same as it would on a real box.

import { expect, test } from 'bun:test'

const ENV_PATH = new URL('../src/env.ts', import.meta.url).pathname

async function runWithEnv(vars: Record<string, string | undefined>) {
  const proc = Bun.spawn(
    ['bun', '-e', `import('${ENV_PATH}').then(m => console.log(JSON.stringify({ editorEnabled: m.editorEnabled, EDITOR_IMAGE: m.env.EDITOR_IMAGE, EDITOR_MAX_RUNNING: m.env.EDITOR_MAX_RUNNING, EDITOR_MEMORY_LIMIT: m.env.EDITOR_MEMORY_LIMIT, EDITOR_CPUS: m.env.EDITOR_CPUS, EDITOR_IDLE_TIMEOUT_SECONDS: m.env.EDITOR_IDLE_TIMEOUT_SECONDS, EDITOR_START_TIMEOUT_MS: m.env.EDITOR_START_TIMEOUT_MS, EDITOR_SETTINGS_FILE: m.env.EDITOR_SETTINGS_FILE })))`],
    {
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
        REDIS_URL: 'redis://127.0.0.1:6399',
        ...vars,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr, exitCode }
}

test('both flags default true -> editorEnabled true', async () => {
  const { stdout, exitCode } = await runWithEnv({})
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).editorEnabled).toBe(true)
})

test('DOCKER_ENABLED=false -> editorEnabled false even with EDITOR_ENABLED=true', async () => {
  const { stdout, exitCode } = await runWithEnv({ DOCKER_ENABLED: 'false', EDITOR_ENABLED: 'true' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).editorEnabled).toBe(false)
})

test('EDITOR_ENABLED=false -> editorEnabled false even with DOCKER_ENABLED=true', async () => {
  const { stdout, exitCode } = await runWithEnv({ DOCKER_ENABLED: 'true', EDITOR_ENABLED: 'false' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).editorEnabled).toBe(false)
})

test('both flags false -> editorEnabled false', async () => {
  const { stdout, exitCode } = await runWithEnv({ DOCKER_ENABLED: 'false', EDITOR_ENABLED: '0' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).editorEnabled).toBe(false)
})

test('EDITOR_IMAGE defaults to the pinned 4.138.0 Debian tag', async () => {
  const { stdout } = await runWithEnv({})
  expect(JSON.parse(stdout).EDITOR_IMAGE).toBe('codercom/code-server:4.138.0')
})

test('EDITOR_IMAGE accepts an ordinary registry/name:tag reference', async () => {
  const { stdout, exitCode } = await runWithEnv({ EDITOR_IMAGE: 'ghcr.io/coder/code-server:4.99.0' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).EDITOR_IMAGE).toBe('ghcr.io/coder/code-server:4.99.0')
})

test('EDITOR_IMAGE rejects a value that could never be a docker reference', async () => {
  const { exitCode, stderr } = await runWithEnv({ EDITOR_IMAGE: 'not a reference!' })
  expect(exitCode).toBe(1)
  expect(stderr).toContain('EDITOR_IMAGE')
})

test('EDITOR_MAX_RUNNING rejects 0 (must be >= 1)', async () => {
  const { exitCode } = await runWithEnv({ EDITOR_MAX_RUNNING: '0' })
  expect(exitCode).toBe(1)
})

test('EDITOR_MEMORY_LIMIT accepts a bare number and a docker-style suffix', async () => {
  const bare = await runWithEnv({ EDITOR_MEMORY_LIMIT: '512' })
  expect(bare.exitCode).toBe(0)
  const suffixed = await runWithEnv({ EDITOR_MEMORY_LIMIT: '2G' })
  expect(suffixed.exitCode).toBe(0)
})

test('EDITOR_MEMORY_LIMIT rejects a value docker --memory could never parse', async () => {
  const { exitCode } = await runWithEnv({ EDITOR_MEMORY_LIMIT: '1 gigabyte' })
  expect(exitCode).toBe(1)
})

test('EDITOR_CPUS accepts a fractional value', async () => {
  const { stdout, exitCode } = await runWithEnv({ EDITOR_CPUS: '0.5' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).EDITOR_CPUS).toBe(0.5)
})

test('EDITOR_CPUS rejects zero and negative values', async () => {
  expect((await runWithEnv({ EDITOR_CPUS: '0' })).exitCode).toBe(1)
  expect((await runWithEnv({ EDITOR_CPUS: '-1' })).exitCode).toBe(1)
})

test('EDITOR_IDLE_TIMEOUT_SECONDS floors at 60', async () => {
  expect((await runWithEnv({ EDITOR_IDLE_TIMEOUT_SECONDS: '59' })).exitCode).toBe(1)
  expect((await runWithEnv({ EDITOR_IDLE_TIMEOUT_SECONDS: '60' })).exitCode).toBe(0)
})

test('EDITOR_START_TIMEOUT_MS must be a positive integer', async () => {
  expect((await runWithEnv({ EDITOR_START_TIMEOUT_MS: '0' })).exitCode).toBe(1)
  expect((await runWithEnv({ EDITOR_START_TIMEOUT_MS: '1' })).exitCode).toBe(0)
})

test('EDITOR_SETTINGS_FILE is unset by default (undefined, not the literal empty string)', async () => {
  const { stdout, exitCode } = await runWithEnv({})
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).EDITOR_SETTINGS_FILE).toBeUndefined()
})

test('EDITOR_SETTINGS_FILE accepts an absolute path', async () => {
  const { stdout, exitCode } = await runWithEnv({ EDITOR_SETTINGS_FILE: '/etc/agentoo/editor-settings.json' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).EDITOR_SETTINGS_FILE).toBe('/etc/agentoo/editor-settings.json')
})

test('EDITOR_SETTINGS_FILE rejects a relative path', async () => {
  const { exitCode, stderr } = await runWithEnv({ EDITOR_SETTINGS_FILE: 'config/editor-settings.json' })
  expect(exitCode).toBe(1)
  expect(stderr).toContain('EDITOR_SETTINGS_FILE')
})

test('a blank EDITOR_SETTINGS_FILE (what an unfilled .env line parses to) is treated as unset', async () => {
  const { stdout, exitCode } = await runWithEnv({ EDITOR_SETTINGS_FILE: '' })
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout).EDITOR_SETTINGS_FILE).toBeUndefined()
})
