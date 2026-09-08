// Runs every database-backed idea-files scenario once, against the throwaway
// cluster its parent (idea-files.test.ts) started, and prints what happened
// as JSON — same shape as attachments-db-child.ts, which this mirrors: the
// child gathers facts, every assertion lives in the parent.

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { closeDb, db } from '@/db/client'
import { ideaFiles, ideas, projects, sessionFiles, sessions } from '@/db/schema'
import { env } from '@/env'
import { totalUsage, uploadFile } from '@/features/attachments/service'
import { attachIdeaAssetsToSession, uploadIdeaFile } from '@/features/ideas/files'
import { ideaUploadsDir, sessionUploadsDir } from '@/lib/paths'

const facts: Record<string, unknown> = {}
const PROJECT_ID = randomUUID()

const streamOf = (body: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })

async function newIdea(): Promise<string> {
  const [row] = await db
    .insert(ideas)
    .values({ projectId: PROJECT_ID, title: 'idea', boardPosition: 0 })
    .returning()
  if (!row) throw new Error('no idea row')
  return row.id
}

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ projectId: PROJECT_ID, status: 'idle' })
    .returning()
  if (!row) throw new Error('no session row')
  return row.id
}

const listDir = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()

/** Blobs only — never ATTACHMENTS.md, which `attachIdeaAssetsToSession`
 * regenerates after every copy, same as an ordinary upload does. */
const listBlobs = async (dir: string) => (await listDir(dir)).filter((n) => n !== 'ATTACHMENTS.md')

async function main() {
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: 'demo', slug: 'demo', source: 'empty', status: 'ready' })

  // --- a per-idea cap rejection deletes the blob it just wrote ---------------
  {
    const idea = await newIdea()
    const originalMax = env.ATTACHMENTS_IDEA_MAX_BYTES
    env.ATTACHMENTS_IDEA_MAX_BYTES = 1500
    await uploadIdeaFile(idea, 'seed.log', streamOf('x'.repeat(1000)), undefined, 1000)
    let error = ''
    try {
      // No size hint: forces the post-write authoritative check rather than
      // the cheap pre-check, exactly like attachments-db-child.ts's own
      // "unhinted" quota scenario.
      await uploadIdeaFile(idea, 'over.log', streamOf('y'.repeat(1000)), undefined, undefined)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    env.ATTACHMENTS_IDEA_MAX_BYTES = originalMax
    const entries = await listDir(ideaUploadsDir(idea))
    facts.ideaCap = {
      error,
      leftNoOverBlob: entries.filter((n) => n.includes('over.log')).length === 0,
      leftNoTmp: entries.filter((n) => n.startsWith('.tmp-')).length === 0,
      rowCount: (await db.select().from(ideaFiles).where(eq(ideaFiles.ideaId, idea))).length,
    }
  }

  // --- totalUsage sums both tables --------------------------------------------
  {
    const idea = await newIdea()
    const session = await newSession()
    const before = await totalUsage()
    await uploadIdeaFile(idea, 'asset.log', streamOf('a'.repeat(500)), undefined, 500)
    await uploadFile(session, 'file.log', streamOf('b'.repeat(700)), undefined, 700)
    const after = await totalUsage()
    facts.totalUsage = { delta: after - before }
  }

  // --- the handoff is idempotent across two calls -----------------------------
  {
    const idea = await newIdea()
    const session = await newSession()
    await uploadIdeaFile(idea, 'one.log', streamOf('one\n'), undefined, 4)
    await uploadIdeaFile(idea, 'two.log', streamOf('two\n'), undefined, 4)

    await attachIdeaAssetsToSession(idea, session)
    const afterFirst = await db
      .select()
      .from(sessionFiles)
      .where(eq(sessionFiles.sessionId, session))
    const blobsAfterFirst = await listBlobs(sessionUploadsDir(session))

    await attachIdeaAssetsToSession(idea, session)
    const afterSecond = await db
      .select()
      .from(sessionFiles)
      .where(eq(sessionFiles.sessionId, session))
    const blobsAfterSecond = await listBlobs(sessionUploadsDir(session))

    facts.handoffIdempotent = {
      rowCountFirst: afterFirst.length,
      rowCountSecond: afterSecond.length,
      sameIds:
        JSON.stringify(afterFirst.map((r) => r.id).sort()) ===
        JSON.stringify(afterSecond.map((r) => r.id).sort()),
      checksumsMatchIdea:
        JSON.stringify(afterFirst.map((r) => r.checksum).sort()) ===
        JSON.stringify(
          ['one\n', 'two\n']
            .map((s) => new Bun.CryptoHasher('sha256').update(s).digest('hex'))
            .sort(),
        ),
      blobCountFirst: blobsAfterFirst.length,
      blobCountSecond: blobsAfterSecond.length,
    }
  }

  // --- the whole-set cap pre-check fails as a unit, leaving the session
  //     unchanged --------------------------------------------------------------
  {
    const idea = await newIdea()
    const session = await newSession()
    for (let i = 0; i < 3; i++) {
      await uploadIdeaFile(idea, `big-${i}.log`, streamOf(`z${i}`.repeat(500)), undefined, 1000)
    }
    const originalMax = env.ATTACHMENTS_SESSION_MAX_BYTES
    // Three ~1000-byte assets against a cap that not even one of them fits
    // under on its own.
    env.ATTACHMENTS_SESSION_MAX_BYTES = 500
    let error = ''
    try {
      await attachIdeaAssetsToSession(idea, session)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    env.ATTACHMENTS_SESSION_MAX_BYTES = originalMax
    const rows = await db.select().from(sessionFiles).where(eq(sessionFiles.sessionId, session))
    const blobs = await listBlobs(sessionUploadsDir(session))
    facts.wholeSetCap = {
      error,
      rowCount: rows.length,
      blobCount: blobs.length,
    }
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
