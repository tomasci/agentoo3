// A deterministic repro for the 100-file cap race in service.ts's
// putEnvFile: 99 files stored, then 20 concurrent PUTs of 20 *new* paths at
// once, racing for the one slot left before ENV_FILE_MAX_FILES_PER_PROJECT.
// Without a lock serializing the count-check-then-write, several of those
// can each read count=99 before any of them has written, and all squeeze
// past the cap. putEnvFile's own per-project mutex (withProjectLock) is what
// makes this deterministic: exactly one of the 20 can ever be the file that
// takes the count from 99 to 100, regardless of the order they actually run
// in, because the lock means no two of them ever read the count at once.
//
// Runs in a child process for the same reason env-files-routes-db-child.ts
// does: `@/env` parses DATABASE_URL/PROJECTS_DIR once, at first import, and
// this needs both pointed at a throwaway cluster and a scratch directory
// before that happens, not whatever the rest of the suite already fixed them
// to (see setup-env.ts). Nothing here needs bullmq or ioredis — putEnvFile
// only ever touches Postgres (the project row) and the filesystem — so,
// unlike that child, nothing needs to be mocked.

import { randomUUID } from 'node:crypto'
import { closeDb, db } from '@/db/client'
import { projects } from '@/db/schema'
import { listStoredPaths, putEnvFile } from '@/features/env-files/service'

const facts: Record<string, unknown> = {}

async function main() {
  const slug = `cap-race-${randomUUID().slice(0, 8)}`
  const [project] = await db
    .insert(projects)
    .values({ name: 'cap-race', slug, source: 'empty', status: 'ready' })
    .returning()
  if (!project) throw new Error('no project row')

  // Sequential: this is the fixture, not the race — writing the first 99 one
  // at a time keeps the starting state deterministic before the concurrent
  // part below even begins.
  for (let i = 0; i < 99; i++) {
    await putEnvFile(project.id, { path: `d${i % 7}/f${i}.env`, content: `N=${i}\n` })
  }

  const CONCURRENT = 20
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, (_, i) =>
      putEnvFile(project.id, { path: `race${i}.env`, content: `R=${i}\n` }),
    ),
  )

  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  facts.race = {
    succeeded: results.length - rejected.length,
    rejectedCount: rejected.length,
    allRejectedAre409: rejected.every((r) => (r.reason as { status?: number })?.status === 409),
    totalStored: (await listStoredPaths(slug)).length,
  }

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
