// How a project's plugin directory is published, against a real filesystem.
//
// A child process because both PROJECTS_DIR and LIBRARY_DIR have to be real
// scratch directories before `@/env` parses them, and the shared test process
// has already fixed both (see setup-env.ts). The database is faked here — the
// only thing these paths read from it is the list of selected items — but the
// filesystem is not, which is the whole point: the change under test is that
// `plugin.json` and an agent's `.md` are now published by rename rather than
// written or removed in place.
//
// The child gathers facts; every assertion lives in plugin-atomicity.test.ts.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'bun:test'

const SRC = new URL('../src', import.meta.url).pathname

// --- a database that answers only the one query these paths make -------------

type Selected = { kind: 'agent' | 'skill'; name: string }

let selectedRows: Selected[] = []
let selectDelayMs = 0
let selectFailsOnce = false
/** Peak overlap between two `runProjectPluginSync` bodies, seen from inside. */
let inFlight = 0
let maxInFlight = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const answer = async () => {
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  try {
    if (selectDelayMs) await sleep(selectDelayMs)
    if (selectFailsOnce) {
      selectFailsOnce = false
      throw new Error('terminating connection due to administrator command')
    }
    return selectedRows
  } finally {
    inFlight--
  }
}

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        then: (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
          answer().then(ok, err),
      }),
    }),
  }),
}

mock.module(`${SRC}/db/client.ts`, () => ({ db, closeDb: async () => {} }))

const { env } = await import(`${SRC}/env.ts`)
const { ensurePluginManifest } = await import(`${SRC}/queue/plugin-manifest.ts`)
const { syncProjectPlugin } = await import(`${SRC}/features/library/service.ts`)

const facts: Record<string, unknown> = {}

const AGENT_BODY = (marker: string) =>
  `---\nrole: subagent\ndescription: Runs the change.\n---\n\n${marker}\n`

const agentsDir = (slug: string) => join(env.PROJECTS_DIR, slug, 'plugin', 'agents')
const skillsDir = (slug: string) => join(env.PROJECTS_DIR, slug, 'plugin', 'skills')
const manifestDir = (slug: string) => join(env.PROJECTS_DIR, slug, 'plugin', '.claude-plugin')

const listing = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()
const inode = async (path: string) => (await stat(path)).ino

async function main() {
  await mkdir(join(env.LIBRARY_DIR, 'agents'), { recursive: true })
  await mkdir(join(env.LIBRARY_DIR, 'skills', 'testing'), { recursive: true })
  await writeFile(join(env.LIBRARY_DIR, 'agents', 'tester.md'), AGENT_BODY('Version one.'))
  await writeFile(join(env.LIBRARY_DIR, 'skills', 'testing', 'SKILL.md'), '# testing\n')

  // --- plugin.json is replaced, never truncated in place ---------------------
  {
    const slug = 'manifest'
    await ensurePluginManifest(slug)
    const first = await inode(join(manifestDir(slug), 'plugin.json'))
    await ensurePluginManifest(slug)
    const second = await inode(join(manifestDir(slug), 'plugin.json'))
    const text = await readFile(join(manifestDir(slug), 'plugin.json'), 'utf8')

    facts.manifest = {
      // A different inode is what rename() leaves behind; writing the same file
      // in place would keep it, and with it the window where a reader sees a
      // half-written manifest.
      replacedByRename: first !== second,
      parsed: JSON.parse(text) as unknown,
      endsWithNewline: text.endsWith('\n'),
      leftovers: (await listing(manifestDir(slug))).filter((n) => n.startsWith('.tmp-')),
    }
  }

  // --- an agent file is never absent, even mid-republish ---------------------
  //
  // The regression the rename guards: rm-then-cp leaves a window with no file
  // at the target at all, and from this version on another turn in the same
  // project can be reading it. A reader loop runs alongside 50 republishes and
  // counts what it saw.
  {
    const slug = 'reader'
    selectedRows = [{ kind: 'agent', name: 'tester' }]
    await syncProjectPlugin(slug, 'project-reader')
    const target = join(agentsDir(slug), 'tester.md')

    let reads = 0
    let missing = 0
    let partial = 0
    let stop = false
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(target, 'utf8')
          reads++
          // Every version of this file both starts and ends with a complete
          // frontmatter block; anything else is a half-copied file.
          if (!text.startsWith('---\n') || !text.trimEnd().endsWith('.')) partial++
        } catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') missing++
          else throw error
        }
      }
    })()

    for (let i = 0; i < 50; i++) {
      await writeFile(join(env.LIBRARY_DIR, 'agents', 'tester.md'), AGENT_BODY(`Version ${i}.`))
      await syncProjectPlugin(slug, 'project-reader')
    }
    stop = true
    await reader

    facts.reader = {
      reads,
      missing,
      partial,
      finalContent: await readFile(target, 'utf8'),
      leftovers: (await listing(agentsDir(slug))).filter((n) => n.startsWith('.tmp-')),
    }
    await writeFile(join(env.LIBRARY_DIR, 'agents', 'tester.md'), AGENT_BODY('Version one.'))
  }

  // --- the prune pass ---------------------------------------------------------
  {
    const slug = 'prune'
    selectedRows = [{ kind: 'agent', name: 'tester' }]
    await syncProjectPlugin(slug, 'project-prune')
    // Something another publish is part-way through, and something genuinely
    // stale. Only one of them is this pass's to remove.
    await writeFile(join(agentsDir(slug), '.tmp-abcdef-tester.md'), 'half a file')
    await writeFile(join(agentsDir(slug), 'retired.md'), AGENT_BODY('Gone.'))
    await syncProjectPlugin(slug, 'project-prune')

    facts.prune = { entries: await listing(agentsDir(slug)) }
  }

  // --- a selection the library no longer has ----------------------------------
  {
    const slug = 'ghost'
    selectedRows = [
      { kind: 'agent', name: 'tester' },
      { kind: 'agent', name: 'ghost' },
      { kind: 'skill', name: 'testing' },
    ]
    let threw = ''
    try {
      await syncProjectPlugin(slug, 'project-ghost')
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }

    facts.missingSource = {
      threw,
      // The one that exists still lands, and the failed copy leaves nothing
      // behind — nothing else ever sweeps a .tmp- name.
      agents: await listing(agentsDir(slug)),
      skills: await listing(skillsDir(slug)),
      skillContents: await listing(join(skillsDir(slug), 'testing')),
    }
  }

  // --- a publish that fails after its temp file exists -------------------------
  //
  // The other half of materialise()'s error branch, and the only one that can
  // strand litter: the copy succeeds and the rename does not. Forced by making
  // the target a non-empty directory, which rename(2) refuses to replace with a
  // file. Nothing sweeps a `.tmp-` name — the prune loop above skips them by
  // design — so a temp file left here would stay forever.
  {
    const slug = 'renamefail'
    selectedRows = [{ kind: 'agent', name: 'tester' }]
    await mkdir(join(agentsDir(slug), 'tester.md'), { recursive: true })
    await writeFile(join(agentsDir(slug), 'tester.md', 'in-the-way'), 'blocking')

    let threw = ''
    try {
      await syncProjectPlugin(slug, 'project-renamefail')
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }

    facts.failedPublish = { threw, entries: await listing(agentsDir(slug)) }
    await rm(join(agentsDir(slug), 'tester.md'), { recursive: true, force: true })
  }

  // --- two syncs of one project do not overlap --------------------------------
  {
    selectedRows = [{ kind: 'agent', name: 'tester' }]
    selectDelayMs = 50

    maxInFlight = 0
    await Promise.all([
      syncProjectPlugin('serial', 'project-serial'),
      syncProjectPlugin('serial', 'project-serial'),
    ])
    const sameSlug = maxInFlight

    maxInFlight = 0
    await Promise.all([
      syncProjectPlugin('one', 'project-one'),
      syncProjectPlugin('two', 'project-two'),
    ])
    const differentSlugs = maxInFlight

    // A failure must not stop the next call in the chain from running.
    maxInFlight = 0
    selectFailsOnce = true
    const outcomes = await Promise.allSettled([
      syncProjectPlugin('recover', 'project-recover'),
      syncProjectPlugin('recover', 'project-recover'),
    ])
    selectDelayMs = 0

    facts.serialization = {
      sameSlug,
      differentSlugs,
      outcomes: outcomes.map((o) => o.status),
      // The caller of the failing call sees its own failure, not a silent
      // success, and the second call still published.
      recoveredEntries: await listing(agentsDir('recover')),
    }
  }

  console.log(`__FACTS__${JSON.stringify(facts)}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(`__ERROR__${detail}`)
    process.exit(1)
  })
