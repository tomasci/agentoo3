// GET/PUT/DELETE /projects/{id}/git-identity end to end: projectsRouter ->
// service -> real git on real repositories, against a real Postgres. See
// git-identity-routes-db-child.ts for the fixture behind each fact, and
// pg-cluster.ts for why this runs in a child process.
//
// Global git config is isolated: the child gets GIT_CONFIG_GLOBAL pointing at
// a scratch file, GIT_CONFIG_NOSYSTEM=1 and a scratch HOME, so neither the
// real ~/.gitconfig nor /etc/gitconfig is ever read or written. The last test
// in this file also checks the real global config is byte-identical before
// and after the run.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const SCRATCH = `/tmp/agentoo-git-identity-routes-${process.pid}`
const OUTER = join(SCRATCH, 'outer')
const PROJECTS = join(OUTER, 'projects')
const GLOBAL = join(SCRATCH, 'global-gitconfig')
const HOME = join(SCRATCH, 'home')

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const realGlobalPath = join(homedir(), '.gitconfig')
const readRealGlobal = async () =>
  existsSync(realGlobalPath) ? await readFile(realGlobalPath, 'utf8') : '<missing>'
const realGlobalBefore = await readRealGlobal()

const hasPostgres = Boolean(postgresBinDir())

function spawnGit(args: string[], cwd: string) {
  return Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME, GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: '1' },
  })
}

if (hasPostgres) {
  try {
    await mkdir(HOME, { recursive: true })
    await mkdir(join(SCRATCH, 'operator'), { recursive: true })
    await writeFile(GLOBAL, '')
    // PROJECTS_DIR inside an outer work tree, as /opt/agentoo/projects sits
    // inside the /opt/agentoo checkout in a real install.
    await mkdir(PROJECTS, { recursive: true })
    if (spawnGit(['init', '-q', '-b', 'main', OUTER], SCRATCH).exitCode !== 0) {
      throw new Error('could not init the outer repo')
    }
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: PROJECTS,
      ATTACHMENTS_DIR: join(SCRATCH, 'attachments'),
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
      HOME,
      GIT_CONFIG_GLOBAL: GLOBAL,
      GIT_CONFIG_NOSYSTEM: '1',
      GID_SCRATCH: SCRATCH,
      GID_OUTER_REPO: OUTER,
    }
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/git-identity-routes-db-child.ts')], {
      cwd: BACKEND,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const marker = stdout.indexOf('__FACTS__')
    if (code !== 0 || marker === -1) {
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-4000)
      setupError = `child exited ${code}: ${failure}`
    } else {
      facts = JSON.parse(stdout.slice(marker + '__FACTS__'.length).trim()) as Facts
    }
  } catch (error) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
}

afterAll(async () => {
  await cluster?.stop()
  await rm(SCRATCH, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip

// biome-ignore lint/suspicious/noExplicitAny: facts are free-form JSON from the child
const fact = (key: string): any => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  if (typeof value.thrown === 'string') throw new Error(`scenario "${key}" threw: ${value.thrown}`)
  return value
}

const UNAVAILABLE = {
  available: false,
  configPath: null,
  local: { name: null, email: null },
  effective: { name: null, email: null },
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn('No Postgres server binaries on this box; git identity route scenarios did not run.')
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'clear',
    'global',
    'globalUntouched',
    'lock',
    'multiValue',
    'notFound',
    'ready',
    'rejects',
    'roundTrip',
    'symlink',
    'unavailable',
  ])
})

// --- shape ------------------------------------------------------------------

dbTest('GET on a ready project with nothing set is a 200 in the GitIdentityState shape', () => {
  const f = fact('ready')
  expect(f.getStatus).toBe(200)
  expect(f.getSchemaOk).toBe(true)
  expect(f.getKeys).toEqual(['available', 'configPath', 'effective', 'local'])
  expect(f.localKeys).toEqual(['email', 'name'])
  expect(f.effectiveKeys).toEqual(['email', 'name'])
  expect(f.getBody).toEqual({
    available: true,
    configPath: f.expectedConfigPath,
    local: { name: null, email: null },
    effective: { name: null, email: null },
  })
})

dbTest('the OpenAPI document declares all three methods with their documented statuses', () => {
  const f = fact('ready')
  expect(f.docMethods).toEqual(['delete', 'get', 'put'])
  expect(f.docGetResponses).toEqual(['200', '404'])
  expect(f.docPutResponses).toEqual(['200', '400', '404', '409'])
  expect(f.docDeleteResponses).toEqual(['200', '404', '409'])
  expect(f.docStateProperties).toEqual(['available', 'configPath', 'effective', 'local'])
  expect(f.docStateRequired).toEqual(['available', 'configPath', 'effective', 'local'])
})

// --- PUT and what a plain commit then carries -------------------------------

dbTest('PUT trims both fields, answers the new state, and GET reads it back', () => {
  const f = fact('ready')
  expect(f.putStatus).toBe(200)
  expect(f.putSchemaOk).toBe(true)
  const expected = {
    available: true,
    configPath: f.expectedConfigPath,
    local: { name: 'Ada Lovelace', email: 'ada@example.com' },
    effective: { name: 'Ada Lovelace', email: 'ada@example.com' },
  }
  expect(f.putBody).toEqual(expected)
  expect(f.getAfterBody).toEqual(expected)
  expect(f.rawName).toEqual(['Ada Lovelace'])
  expect(f.rawEmail).toEqual(['ada@example.com'])
})

dbTest('a session worktree then commits as that author and committer with no -c flags', () => {
  const f = fact('ready')
  expect(f.worktreeAdded).toBe(true)
  expect(f.wtCommonDirConfig).toBe(f.expectedConfigPath)
  expect(f.commitErr).toBe('')
  expect(f.commitCode).toBe(0)
  expect(f.log).toBe('Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>')
})

dbTest('names with spaces, unicode, quotes, backslashes and comment characters round-trip exactly', () => {
  const f = fact('roundTrip')
  for (const c of f.cases) {
    expect({ sent: c.sent, putStatus: c.putStatus }).toEqual({ sent: c.sent, putStatus: 200 })
    expect(c.putName).toBe(c.sent)
    expect(c.getName).toBe(c.sent)
    expect(c.raw).toEqual([c.sent])
  }
  expect(f.cases.map((c: { sent: string }) => c.sent)).toContain('Зоя Иванова')
  expect(f.cases.map((c: { sent: string }) => c.sent)).toContain("José O'Brien")
})

dbTest('a 254-character email and a GitHub noreply email are accepted', () => {
  const f = fact('roundTrip')
  expect(f.longEmailLength).toBe(254)
  expect(f.longEmailStatus).toBe(200)
  expect(f.noreplyStatus).toBe(200)
  expect(f.noreplyBack).toBe('123456+zoya@users.noreply.github.com')
  expect(f.commitCode).toBe(0)
  expect(f.log).toBe('Зоя Иванова <123456+zoya@users.noreply.github.com>')
})

// --- 400 --------------------------------------------------------------------

const REJECTED = [
  'emptyBody',
  'missingName',
  'missingEmail',
  'nameNumber',
  'nameNull',
  'emailNull',
  'emptyName',
  'blankName',
  'nameTooLong',
  'nameNewline',
  'nameInjection',
  'nameInjectionLeadingNewline',
  'nameCarriageReturn',
  'nameTab',
  'nameNul',
  'nameDel',
  'nameC1',
  'nameLt',
  'nameGt',
  'nameDash',
  'nameDashAfterTrim',
  'nameDoubleDash',
  'emailEmpty',
  'emailNoAt',
  'emailTwoAt',
  'emailSpace',
  'emailBracketed',
  'emailDash',
  'emailTooShort',
  'emailEmptyLocal',
  'emailTooLong',
  'emailNewline',
  'emailInternalNewline',
  'emailTab',
]

for (const key of REJECTED) {
  dbTest(`PUT rejects ${key} with a 400 "Validation failed" naming the field`, () => {
    const c = fact('rejects').cases[key]
    expect(c.status).toBe(400)
    expect(c.error).toBe('Validation failed')
    const field = /email/i.test(key) ? 'email' : 'name'
    if (key === 'emptyBody') expect(c.issuePaths.sort()).toEqual(['email', 'name'])
    else expect(c.issuePaths).toContain(field)
  })
}

dbTest('a malformed JSON body is a 4xx, not a 500', () => {
  const s = fact('rejects').malformedJsonStatus
  expect(s).toBeGreaterThanOrEqual(400)
  expect(s).toBeLessThan(500)
})

dbTest('no rejected PUT changes a single byte of the repo config', () => {
  const f = fact('rejects')
  expect(f.configUnchanged).toBe(true)
  expect(f.configMentionsEvil).toBe(false)
  expect(f.nameAfter).toEqual(['Kept Name'])
  expect(f.emailAfter).toEqual(['kept@example.com'])
  expect(f.sshCommandAfter).toBeNull()
})

// --- 404 --------------------------------------------------------------------

dbTest('an unknown project is a 404 on GET, PUT and DELETE; a non-uuid id is a 400', () => {
  const f = fact('notFound')
  expect(f.get).toBe(404)
  expect(f.getError).toBe('Project not found')
  expect(f.put).toBe(404)
  expect(f.del).toBe(404)
  expect(f.notUuid).toBe(400)
})

// --- unavailable ------------------------------------------------------------

for (const status of ['pending', 'cloning', 'needs_manual', 'failed']) {
  dbTest(`a ${status} project reads as unavailable, refuses PUT/DELETE with 409, and its repo is untouched`, () => {
    const f = fact('unavailable')[status]
    expect(f.get).toBe(200)
    expect(f.getBody).toEqual(UNAVAILABLE)
    expect(f.put).toBe(409)
    expect(typeof f.putError).toBe('string')
    expect(f.del).toBe(409)
    expect(f.configUnchanged).toBe(true)
  })
}

dbTest('a ready project whose repo/ is missing reads as unavailable (200), and PUT is a 409', () => {
  const f = fact('unavailable').readyMissingRepo
  expect({ get: f.get, put: f.put, del: f.del }).toEqual({ get: 200, put: 409, del: 409 })
  expect(f.getBody).toEqual(UNAVAILABLE)
})

dbTest('an adopted project whose target folder was deleted reads as unavailable (200), PUT 409', () => {
  const f = fact('unavailable').readyDanglingSymlink
  expect({ get: f.get, put: f.put }).toEqual({ get: 200, put: 409 })
  expect(f.getBody).toEqual(UNAVAILABLE)
})

dbTest('a ready project whose repo/ is not a git repo is unavailable, even inside an outer work tree', () => {
  const f = fact('unavailable').readyPlainDirInsideOuterRepo
  expect(f.get).toBe(200)
  expect(f.getBody).toEqual(UNAVAILABLE)
  expect(f.put).toBe(409)
  expect(f.del).toBe(409)
  // The real damage if the gate is wrong: the enclosing repository's config
  // (agentoo's own checkout, in a real install) gets the identity.
  expect(f.outerNameAfterPut).toBeNull()
  expect(f.outerConfigChangedByPut).toBe(false)
})

dbTest('an adopted non-git folder (allowed by project setup) is unavailable, and PUT never writes the enclosing repo', () => {
  const f = fact('unavailable').readyAdoptedNonGitFolder
  expect(f.get).toBe(200)
  expect(f.getBody).toEqual(UNAVAILABLE)
  expect(f.put).toBe(409)
  expect(f.outerNameAfterPut).toBeNull()
  expect(f.outerConfigChangedByPut).toBe(false)
})

// --- DELETE -----------------------------------------------------------------

dbTest('DELETE is a 200 twice over and leaves local null', () => {
  const f = fact('clear')
  expect(f.put).toBe(200)
  expect(f.first).toBe(200)
  expect(f.second).toBe(200)
  for (const body of [f.firstBody, f.secondBody, f.getBody]) {
    expect(body.available).toBe(true)
    expect(body.local).toEqual({ name: null, email: null })
    expect(body.effective).toEqual({ name: null, email: null })
  }
  expect(f.name).toBeNull()
  expect(f.email).toBeNull()
})

dbTest('DELETE leaves core.sshCommand, remotes, user.signingkey and other keys intact', () => {
  const f = fact('clear')
  expect(f.sshCommand).toEqual(['ssh -i /keys/x -o IdentitiesOnly=yes'])
  expect(f.remoteUrl).toEqual(['git@example.com:acme/x.git'])
  expect(f.remoteFetch).toEqual(['+refs/heads/*:refs/remotes/origin/*'])
  expect(f.signingKey).toEqual(['ABCDEF'])
  expect(f.marker).toEqual(['keep-me'])
})

// --- global config ------------------------------------------------------------

dbTest('effective includes global config; local stays null until PUT; PUT/DELETE never touch global', () => {
  const f = fact('global')
  expect(f.get.local).toEqual({ name: null, email: null })
  expect(f.get.effective).toEqual({ name: 'Global Person', email: 'global@example.com' })
  expect(f.put.local).toEqual({ name: 'Local Person', email: 'local@example.com' })
  expect(f.put.effective).toEqual({ name: 'Local Person', email: 'local@example.com' })
  expect(f.del.local).toEqual({ name: null, email: null })
  expect(f.del.effective).toEqual({ name: 'Global Person', email: 'global@example.com' })
  expect(f.globalUntouchedByPut).toBe(true)
  expect(f.globalUntouchedByDelete).toBe(true)
})

// --- adopted (symlinked) repo -------------------------------------------------

dbTest("an adopted project's configPath is the real target's config, and PUT lands there", () => {
  const f = fact('symlink')
  expect(f.getStatus).toBe(200)
  expect(f.configPath).toBe(f.expected)
  expect(f.putConfigPath).toBe(f.expected)
  expect(String(f.configPath).startsWith(String(f.projectsDir))).toBe(false)
  expect(f.putStatus).toBe(200)
  expect(f.targetName).toEqual(['Adopted Author'])
  expect(f.targetEmail).toEqual(['adopted@example.com'])
  expect(f.fileHasName).toBe(true)
  expect(f.repoIsSymlinkStill).toBe(true)
  expect(f.commitCode).toBe(0)
  expect(f.log).toBe('Adopted Author <adopted@example.com>')
})

// --- multi-valued -------------------------------------------------------------

dbTest('a hand-edited two-line user.name reads as its last line, and PUT collapses it to one', () => {
  const f = fact('multiValue')
  expect(f.before).toEqual(['First Line', 'Second Line'])
  expect(f.getLocal).toEqual({ name: 'Second Line', email: 'multi@example.com' })
  expect(f.getEffective).toEqual({ name: 'Second Line', email: 'multi@example.com' })
  expect(f.put).toBe(200)
  expect(f.after).toEqual(['Collapsed'])
  expect(f.nameLinesInFile).toBe(1)
})

// --- lock contention ------------------------------------------------------------

dbTest('a held config.lock makes PUT and DELETE a 409 with a retry message, and is left alone', () => {
  const f = fact('lock')
  expect(f.put).toBe(409)
  expect(String(f.putError)).toMatch(/try again/i)
  expect(f.del).toBe(409)
  expect(String(f.delError)).toMatch(/try again/i)
  expect(f.lockStill).toBe(true)
  expect(f.lockContent).toBe('held-by-test\n')
  expect(f.configUnchanged).toBe(true)
  expect(f.getDuringLock).toBe(200)
  expect(f.getLocalDuringLock).toEqual({ name: 'Before Lock', email: 'before@example.com' })
  expect(f.putAfter).toBe(200)
  expect(f.localAfter).toEqual({ name: 'After Lock', email: 'after@example.com' })
})

// --- isolation --------------------------------------------------------------------

dbTest('the scratch global config is only changed by the scenario that writes it on purpose', () => {
  const f = fact('globalUntouched')
  expect(f.after).toBe(f.before)
})

test("this file never changes the real user's ~/.gitconfig", async () => {
  expect(await readRealGlobal()).toBe(realGlobalBefore)
})
