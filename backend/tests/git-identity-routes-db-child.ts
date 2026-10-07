// Runs every HTTP-contract scenario for GET/PUT/DELETE
// /projects/{id}/git-identity once, against the throwaway cluster its parent
// (git-identity-routes.test.ts) started, and prints what happened as JSON —
// the child gathers facts, every assertion lives in the parent (same shape as
// automations-routes-db-child.ts).
//
// The router is mounted under a parent OpenAPIHono with the real validation
// hook, the way app.ts mounts it. Every repo is a real git repository on disk
// under a temp PROJECTS_DIR; the parent points GIT_CONFIG_GLOBAL, HOME and
// GIT_CONFIG_NOSYSTEM at scratch values so nothing here can read or write the
// real ~/.gitconfig.
//
// PROJECTS_DIR is deliberately *inside* an outer git work tree (the parent
// passes OUTER_REPO), because that is the deployed layout: /opt/agentoo is
// agentoo's own checkout and the default PROJECTS_DIR is /opt/agentoo/projects.

import { mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname

mock.module('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' }
    }
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
}))

mock.module('ioredis', () => {
  class FakeRedis {
    on() {
      return this
    }
    async quit() {}
    disconnect() {}
  }
  return { default: FakeRedis, Redis: FakeRedis }
})

mock.module(`${SRC}/lib/events.ts`, () => ({
  sessionChannel: (id: string) => `agentoo:session:${id}`,
  controlChannel: (id: string) => `agentoo:control:${id}`,
  publishSessionEvent: async () => {},
  publishControl: async () => {},
  subscribeSession: () => () => {},
  subscribeControl: () => () => {},
}))

const { closeDb, db } = await import(`${SRC}/db/client.ts`)
const { projects } = await import(`${SRC}/db/schema.ts`)
const { projectsRouter } = await import(`${SRC}/features/projects/routes.ts`)
const { gitIdentityStateSchema } = await import(`${SRC}/features/projects/schema.ts`)
const { addWorktree, git } = await import(`${SRC}/lib/git.ts`)
const { projectRepo, projectRoot } = await import(`${SRC}/lib/paths.ts`)
const { OpenAPIHono } = await import('@hono/zod-openapi')
const { openApiValidationHook } = await import(`${SRC}/lib/openapi-hook.ts`)

const app = new OpenAPIHono({ defaultHook: openApiValidationHook })
app.route('/api', projectsRouter)

const SCRATCH = process.env.GID_SCRATCH ?? ''
const OUTER_REPO = process.env.GID_OUTER_REPO ?? ''
const GLOBAL_CONFIG = process.env.GIT_CONFIG_GLOBAL ?? ''
if (!SCRATCH || !OUTER_REPO || !GLOBAL_CONFIG) throw new Error('child needs GID_* env')

const facts: Record<string, unknown> = {}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json as Record<string, unknown> }
}

/** git with nothing but PATH and the scratch global config: no -c flags, no
 * inherited GIT_SSH_COMMAND, no real HOME — what an agent or a human runs. */
function bare(args: string[], cwd: string) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/nonexistent',
      GIT_CONFIG_GLOBAL: GLOBAL_CONFIG,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout).replace(/\n$/, ''),
    err: new TextDecoder().decode(proc.stderr).trim(),
  }
}

async function initRepo(path: string): Promise<void> {
  const init = await git(['init', '-q', '-b', 'main', path])
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  const commit = await git(
    ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'first'],
    path,
  )
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`)
}

type Status = 'pending' | 'cloning' | 'ready' | 'needs_manual' | 'failed'

async function insertProject(
  name: string,
  status: Status,
  source: 'empty' | 'existing' = 'empty',
): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${randomUUID().slice(0, 8)}`
  const [row] = await db.insert(projects).values({ name, slug, source, status }).returning()
  if (!row) throw new Error('no project row')
  return { id: row.id, slug }
}

/** A ready project with a real repo (one commit, no identity). */
async function newProject(name: string, status: Status = 'ready') {
  const p = await insertProject(name, status)
  await initRepo(projectRepo(p.slug))
  return { ...p, repo: projectRepo(p.slug) }
}

const sha = async (path: string) =>
  existsSync(path)
    ? new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex')
    : 'missing'

const localGetAll = (repo: string, key: string) => {
  const r = bare(['config', '--local', '--get-all', key], repo)
  return r.code === 0 ? r.out.split('\n') : null
}

async function scenario(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    facts[name] = await fn()
  } catch (error) {
    facts[name] = {
      thrown: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
  }
}

const globalBefore = await sha(GLOBAL_CONFIG)

async function main() {
  // --- a ready project: shape, PUT, and a plain commit picking it up ---------
  await scenario('ready', async () => {
    const p = await newProject('ready')
    const get = await call('GET', `/projects/${p.id}/git-identity`)
    const parsed = gitIdentityStateSchema.safeParse(get.body)
    const b = get.body as {
      local?: Record<string, unknown>
      effective?: Record<string, unknown>
    }

    const put = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: '  Ada Lovelace  ',
      email: '  ada@example.com  ',
    })
    const getAfter = await call('GET', `/projects/${p.id}/git-identity`)

    // A session worktree — shares repo/.git/config — commits with no -c flags.
    const wt = join(projectRoot(p.slug), 'worktrees', 'sess-1')
    const added = await addWorktree(p.repo, wt, 'agentoo/s-ready')
    await writeFile(join(wt, 'a.txt'), 'hello\n')
    const add = bare(['add', '-A'], wt)
    const commit = bare(['commit', '-qm', 'from worktree'], wt)
    const log = bare(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], wt)
    // GET through the worktree path must also report the shared config.
    const wtCommonDir = bare(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt)

    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    }) as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
      components: { schemas: Record<string, { required?: string[]; properties?: object }> }
    }
    const pathDoc = doc.paths['/api/projects/{id}/git-identity'] ?? {}
    const stateDoc = doc.components.schemas.GitIdentityState

    return {
      getStatus: get.status,
      getBody: get.body,
      getSchemaOk: parsed.success,
      getKeys: Object.keys(get.body ?? {}).sort(),
      localKeys: Object.keys(b.local ?? {}).sort(),
      effectiveKeys: Object.keys(b.effective ?? {}).sort(),
      expectedConfigPath: join(await realpath(p.repo), '.git', 'config'),
      putStatus: put.status,
      putBody: put.body,
      putSchemaOk: gitIdentityStateSchema.safeParse(put.body).success,
      getAfterBody: getAfter.body,
      rawName: localGetAll(p.repo, 'user.name'),
      rawEmail: localGetAll(p.repo, 'user.email'),
      worktreeAdded: added.ok,
      addCode: add.code,
      commitCode: commit.code,
      commitErr: commit.err,
      log: log.out,
      wtCommonDirConfig: join(wtCommonDir.out, 'config'),
      docMethods: Object.keys(pathDoc).sort(),
      docGetResponses: Object.keys(pathDoc.get?.responses ?? {}).sort(),
      docPutResponses: Object.keys(pathDoc.put?.responses ?? {}).sort(),
      docDeleteResponses: Object.keys(pathDoc.delete?.responses ?? {}).sort(),
      docStateRequired: [...(stateDoc?.required ?? [])].sort(),
      docStateProperties: Object.keys(stateDoc?.properties ?? {}).sort(),
    }
  })

  // --- values with spaces, unicode, quotes and comment characters round-trip --
  await scenario('roundTrip', async () => {
    const p = await newProject('roundtrip')
    const names = [
      'Зоя Иванова',
      "José O'Brien",
      'Ada "The Countess" Lovelace',
      'Back\\slash Person',
      'Hash # and ; semi',
      '李小龙',
      '🦀 Crab Person',
      'n'.repeat(200),
    ]
    const out: Record<string, unknown>[] = []
    for (const name of names) {
      const put = await call('PUT', `/projects/${p.id}/git-identity`, {
        name,
        email: 'zoya@example.com',
      })
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      out.push({
        sent: name,
        putStatus: put.status,
        putName: (put.body?.local as { name?: string } | undefined)?.name,
        getName: (get.body?.local as { name?: string } | undefined)?.name,
        raw: localGetAll(p.repo, 'user.name'),
      })
    }
    const longEmail = `${'e'.repeat(254 - '@example.com'.length)}@example.com`
    const emailPut = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'Зоя Иванова',
      email: longEmail,
    })
    const noreply = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'Зоя Иванова',
      email: '123456+zoya@users.noreply.github.com',
    })
    await writeFile(join(p.repo, 'z.txt'), 'z\n')
    bare(['add', '-A'], p.repo)
    const commit = bare(['commit', '-qm', 'unicode author'], p.repo)
    const log = bare(['log', '-1', '--format=%an <%ae>'], p.repo)
    return {
      cases: out,
      longEmailLength: longEmail.length,
      longEmailStatus: emailPut.status,
      longEmailBack: (emailPut.body?.local as { email?: string } | undefined)?.email,
      noreplyStatus: noreply.status,
      noreplyBack: (noreply.body?.local as { email?: string } | undefined)?.email,
      commitCode: commit.code,
      log: log.out,
    }
  })

  // --- every bad-input class is a 400 that touches nothing ------------------
  await scenario('rejects', async () => {
    const p = await newProject('rejects')
    bare(['config', 'user.name', 'Kept Name'], p.repo)
    bare(['config', 'user.email', 'kept@example.com'], p.repo)
    const configPath = join(p.repo, '.git', 'config')
    const before = await sha(configPath)
    const ok = { name: 'Ada Lovelace', email: 'ada@example.com' }
    const cases: Record<string, unknown> = {
      emptyBody: {},
      missingName: { email: ok.email },
      missingEmail: { name: ok.name },
      nameNumber: { ...ok, name: 42 },
      nameNull: { ...ok, name: null },
      emailNull: { ...ok, email: null },
      emptyName: { ...ok, name: '' },
      blankName: { ...ok, name: '   \t ' },
      nameTooLong: { ...ok, name: 'a'.repeat(201) },
      nameNewline: { ...ok, name: 'Ada\nLovelace' },
      nameInjection: { ...ok, name: 'Ada\n[core]\n\tsshCommand=evil' },
      nameInjectionLeadingNewline: { ...ok, name: '\n[core]\n\tsshCommand=evil' },
      nameCarriageReturn: { ...ok, name: 'Ada\r[core]' },
      nameTab: { ...ok, name: 'Ada\tLovelace' },
      nameNul: { ...ok, name: 'Ada\u0000Lovelace' },
      nameDel: { ...ok, name: 'Ada\u007fLovelace' },
      nameC1: { ...ok, name: 'Ada\u0085Lovelace' },
      nameLt: { ...ok, name: 'Ada <x' },
      nameGt: { ...ok, name: 'Ada > x' },
      nameDash: { ...ok, name: '-Ada' },
      nameDashAfterTrim: { ...ok, name: '   -Ada' },
      nameDoubleDash: { ...ok, name: '--global' },
      emailEmpty: { ...ok, email: '' },
      emailNoAt: { ...ok, email: 'ada.example.com' },
      emailTwoAt: { ...ok, email: 'a@b@example.com' },
      emailSpace: { ...ok, email: 'ada lovelace@example.com' },
      emailBracketed: { ...ok, email: '<ada@example.com>' },
      emailDash: { ...ok, email: '-ada@example.com' },
      emailTooShort: { ...ok, email: 'a@' },
      emailEmptyLocal: { ...ok, email: '@example.com' },
      emailTooLong: { ...ok, email: `${'e'.repeat(255 - '@example.com'.length)}@example.com` },
      emailNewline: { ...ok, email: 'ada@example.com\n[core]\n\tsshCommand=evil' },
      emailInternalNewline: { ...ok, email: 'ada@exa\nmple.com' },
      emailTab: { ...ok, email: 'ada@exa\tmple.com' },
    }
    const out: Record<string, unknown> = {}
    for (const [key, body] of Object.entries(cases)) {
      const res = await call('PUT', `/projects/${p.id}/git-identity`, body)
      out[key] = {
        status: res.status,
        error: res.body?.error,
        issuePaths: Array.isArray(res.body?.issues)
          ? (res.body.issues as { path: string }[]).map((i) => i.path)
          : null,
      }
    }
    const malformed = await call('PUT', `/projects/${p.id}/git-identity`, '{"name": "x", ')
    const after = await sha(configPath)
    const text = await readFile(configPath, 'utf8')
    return {
      cases: out,
      malformedJsonStatus: malformed.status,
      configUnchanged: before === after,
      configMentionsEvil: text.includes('evil'),
      nameAfter: localGetAll(p.repo, 'user.name'),
      emailAfter: localGetAll(p.repo, 'user.email'),
      sshCommandAfter: localGetAll(p.repo, 'core.sshcommand'),
    }
  })

  // --- 404 / malformed id ---------------------------------------------------
  await scenario('notFound', async () => {
    const ghost = randomUUID()
    const get = await call('GET', `/projects/${ghost}/git-identity`)
    const put = await call('PUT', `/projects/${ghost}/git-identity`, {
      name: 'Ada',
      email: 'ada@example.com',
    })
    const del = await call('DELETE', `/projects/${ghost}/git-identity`)
    const notUuid = await call('GET', '/projects/not-a-uuid/git-identity')
    return {
      get: get.status,
      getError: get.body?.error,
      put: put.status,
      del: del.status,
      notUuid: notUuid.status,
    }
  })

  // --- not available: wrong status, missing repo, non-git repo/ -------------
  await scenario('unavailable', async () => {
    const out: Record<string, unknown> = {}
    const ok = { name: 'Ada Lovelace', email: 'ada@example.com' }

    // Not ready, but a real repo with a hand-set identity is already on disk:
    // nothing may be read from it or written to it.
    for (const status of ['pending', 'cloning', 'needs_manual', 'failed'] as const) {
      const p = await newProject(`st-${status.replace('_', '-')}`, status)
      bare(['config', 'user.name', 'Hand Set'], p.repo)
      bare(['config', 'user.email', 'hand@example.com'], p.repo)
      const configPath = join(p.repo, '.git', 'config')
      const before = await sha(configPath)
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, ok)
      const del = await call('DELETE', `/projects/${p.id}/git-identity`)
      out[status] = {
        get: get.status,
        getBody: get.body,
        put: put.status,
        putError: put.body?.error,
        del: del.status,
        configUnchanged: before === (await sha(configPath)),
      }
    }

    // Ready, but repo/ does not exist at all (project root exists).
    {
      const p = await insertProject('ready-missing', 'ready')
      await mkdir(projectRoot(p.slug), { recursive: true })
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, ok)
      const del = await call('DELETE', `/projects/${p.id}/git-identity`)
      out.readyMissingRepo = {
        get: get.status,
        getBody: get.body,
        put: put.status,
        putError: put.body?.error,
        del: del.status,
      }
    }

    // Ready, adopted, and the folder repo/ points at was deleted afterwards.
    {
      const p = await insertProject('ready-dangling', 'ready', 'existing')
      const target = join(SCRATCH, 'operator', `gone-${p.slug}`)
      await initRepo(target)
      await mkdir(projectRoot(p.slug), { recursive: true })
      await symlink(target, projectRepo(p.slug), 'dir')
      await rm(target, { recursive: true, force: true })
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, ok)
      out.readyDanglingSymlink = {
        get: get.status,
        getBody: get.body,
        put: put.status,
        putError: put.body?.error,
      }
    }

    // Ready, repo/ is a plain directory that is not a git repo — but, as in
    // production, PROJECTS_DIR sits inside an outer git work tree.
    {
      const p = await insertProject('ready-plain', 'ready')
      await mkdir(projectRepo(p.slug), { recursive: true })
      await writeFile(join(projectRepo(p.slug), 'README'), 'not a repo\n')
      const outerConfig = join(OUTER_REPO, '.git', 'config')
      const outerBefore = await sha(outerConfig)
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, ok)
      const outerName = localGetAll(OUTER_REPO, 'user.name')
      const outerAfterPut = await sha(outerConfig)
      const del = await call('DELETE', `/projects/${p.id}/git-identity`)
      out.readyPlainDirInsideOuterRepo = {
        get: get.status,
        getBody: get.body,
        put: put.status,
        putBody: put.body,
        outerNameAfterPut: outerName,
        del: del.status,
        outerConfigChangedByPut: outerBefore !== outerAfterPut,
        outerConfigPath: outerConfig,
      }
      // Leave the outer repo as we found it for later scenarios.
      bare(['config', '--local', '--unset-all', 'user.name'], OUTER_REPO)
      bare(['config', '--local', '--unset-all', 'user.email'], OUTER_REPO)
    }

    // Ready, adopted from SOURCES_DIR, and the adopted folder is not a git
    // repo — which project-setup.worker.ts explicitly allows ("A project need
    // not be a git repo at all"). SOURCES_DIR defaults to /opt/agentoo/sources,
    // inside agentoo's own checkout; the outer repo stands in for that.
    {
      const p = await insertProject('adopted-plain', 'ready', 'existing')
      const target = join(OUTER_REPO, 'sources', `plain-${p.slug}`)
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'notes.txt'), 'just files\n')
      await mkdir(projectRoot(p.slug), { recursive: true })
      await symlink(target, projectRepo(p.slug), 'dir')
      const outerConfig = join(OUTER_REPO, '.git', 'config')
      const outerBefore = await sha(outerConfig)
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, ok)
      const outerName = localGetAll(OUTER_REPO, 'user.name')
      const outerAfterPut = await sha(outerConfig)
      out.readyAdoptedNonGitFolder = {
        get: get.status,
        getBody: get.body,
        put: put.status,
        outerNameAfterPut: outerName,
        outerConfigChangedByPut: outerBefore !== outerAfterPut,
      }
      bare(['config', '--local', '--unset-all', 'user.name'], OUTER_REPO)
      bare(['config', '--local', '--unset-all', 'user.email'], OUTER_REPO)
    }
    return out
  })

  // --- DELETE twice; only user.name/user.email removed ----------------------
  await scenario('clear', async () => {
    const p = await newProject('clear')
    bare(['config', 'core.sshCommand', 'ssh -i /keys/x -o IdentitiesOnly=yes'], p.repo)
    bare(['remote', 'add', 'origin', 'git@example.com:acme/x.git'], p.repo)
    bare(['config', 'user.signingkey', 'ABCDEF'], p.repo)
    bare(['config', 'agentoo.marker', 'keep-me'], p.repo)
    const put = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'To Clear',
      email: 'clear@example.com',
    })
    // A stray hand-added second email line must also go.
    bare(['config', '--add', 'user.email', 'second@example.com'], p.repo)
    const first = await call('DELETE', `/projects/${p.id}/git-identity`)
    const second = await call('DELETE', `/projects/${p.id}/git-identity`)
    const get = await call('GET', `/projects/${p.id}/git-identity`)
    return {
      put: put.status,
      first: first.status,
      firstBody: first.body,
      second: second.status,
      secondBody: second.body,
      getBody: get.body,
      name: localGetAll(p.repo, 'user.name'),
      email: localGetAll(p.repo, 'user.email'),
      sshCommand: localGetAll(p.repo, 'core.sshcommand'),
      remoteUrl: localGetAll(p.repo, 'remote.origin.url'),
      remoteFetch: localGetAll(p.repo, 'remote.origin.fetch'),
      signingKey: localGetAll(p.repo, 'user.signingkey'),
      marker: localGetAll(p.repo, 'agentoo.marker'),
    }
  })

  // --- global config: effective sees it, PUT never writes it ----------------
  await scenario('global', async () => {
    const p = await newProject('global')
    const g0 = await readFile(GLOBAL_CONFIG, 'utf8').catch(() => '')
    await writeFile(GLOBAL_CONFIG, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
    try {
      const globalBeforePut = await sha(GLOBAL_CONFIG)
      const get = await call('GET', `/projects/${p.id}/git-identity`)
      const put = await call('PUT', `/projects/${p.id}/git-identity`, {
        name: 'Local Person',
        email: 'local@example.com',
      })
      const globalAfterPut = await sha(GLOBAL_CONFIG)
      const del = await call('DELETE', `/projects/${p.id}/git-identity`)
      const globalAfterDelete = await sha(GLOBAL_CONFIG)
      return {
        get: get.body,
        put: put.body,
        del: del.body,
        globalUntouchedByPut: globalBeforePut === globalAfterPut,
        globalUntouchedByDelete: globalBeforePut === globalAfterDelete,
      }
    } finally {
      await writeFile(GLOBAL_CONFIG, g0)
    }
  })

  // --- adopted project: repo/ is a symlink ---------------------------------
  await scenario('symlink', async () => {
    const p = await insertProject('adopted', 'ready', 'existing')
    const target = join(SCRATCH, 'operator', `real-${p.slug}`)
    await initRepo(target)
    await mkdir(projectRoot(p.slug), { recursive: true })
    await symlink(target, projectRepo(p.slug), 'dir')
    const get = await call('GET', `/projects/${p.id}/git-identity`)
    const put = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'Adopted Author',
      email: 'adopted@example.com',
    })
    const targetConfig = join(await realpath(target), '.git', 'config')
    const configText = await readFile(targetConfig, 'utf8')
    await writeFile(join(target, 'f.txt'), 'f\n')
    bare(['add', '-A'], target)
    const commit = bare(['commit', '-qm', 'adopted'], target)
    return {
      getStatus: get.status,
      configPath: get.body?.configPath,
      putConfigPath: put.body?.configPath,
      expected: targetConfig,
      projectsDir: process.env.PROJECTS_DIR,
      putStatus: put.status,
      targetName: localGetAll(target, 'user.name'),
      targetEmail: localGetAll(target, 'user.email'),
      fileHasName: configText.includes('Adopted Author'),
      repoIsSymlinkStill: (await realpath(projectRepo(p.slug))) === (await realpath(target)),
      commitCode: commit.code,
      log: bare(['log', '-1', '--format=%an <%ae>'], target).out,
    }
  })

  // --- hand-edited multi-valued user.name ---------------------------------
  await scenario('multiValue', async () => {
    const p = await newProject('multi')
    bare(['config', '--add', 'user.name', 'First Line'], p.repo)
    bare(['config', '--add', 'user.name', 'Second Line'], p.repo)
    bare(['config', 'user.email', 'multi@example.com'], p.repo)
    const before = localGetAll(p.repo, 'user.name')
    const get = await call('GET', `/projects/${p.id}/git-identity`)
    const put = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'Collapsed',
      email: 'multi@example.com',
    })
    const text = await readFile(join(p.repo, '.git', 'config'), 'utf8')
    return {
      before,
      getLocal: get.body?.local,
      getEffective: get.body?.effective,
      put: put.status,
      after: localGetAll(p.repo, 'user.name'),
      nameLinesInFile: text.split('\n').filter((l) => /^\s*name\s*=/.test(l)).length,
    }
  })

  // --- lock contention ---------------------------------------------------
  await scenario('lock', async () => {
    const p = await newProject('lock')
    await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'Before Lock',
      email: 'before@example.com',
    })
    const commonDir = bare(['rev-parse', '--path-format=absolute', '--git-common-dir'], p.repo).out
    const lockPath = join(commonDir, 'config.lock')
    await writeFile(lockPath, 'held-by-test\n')
    const configPath = join(commonDir, 'config')
    const before = await sha(configPath)
    const put = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'During Lock',
      email: 'during@example.com',
    })
    const del = await call('DELETE', `/projects/${p.id}/git-identity`)
    const get = await call('GET', `/projects/${p.id}/git-identity`)
    const lockStill = existsSync(lockPath)
    const lockContent = lockStill ? await readFile(lockPath, 'utf8') : null
    const configUnchanged = before === (await sha(configPath))
    await rm(lockPath, { force: true })
    const putAfter = await call('PUT', `/projects/${p.id}/git-identity`, {
      name: 'After Lock',
      email: 'after@example.com',
    })
    return {
      put: put.status,
      putError: put.body?.error,
      del: del.status,
      delError: del.body?.error,
      getDuringLock: get.status,
      getLocalDuringLock: get.body?.local,
      lockStill,
      lockContent,
      configUnchanged,
      putAfter: putAfter.status,
      localAfter: putAfter.body?.local,
    }
  })

  facts.globalUntouched = { before: globalBefore, after: await sha(GLOBAL_CONFIG) }
  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(async () => {
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
