// Regression coverage for the four handoff defects an independent
// verification pass reproduced against real Postgres: a card stranded by a
// crash between claimIdeaForHandoff's own two writes, a stuck-pending
// prompt's documented "regenerate" remedy that used to do nothing, an idea
// asset the agent could be told to read that a checksum collision never
// actually placed in its session, and an upload response naming a file the
// caller did not send. See idea-handoff-recovery-db-child.ts for the exact
// fixture behind each fact below, and what is real versus faked there.
//
// Every assertion lives here, not in the child, for the same reason every
// other db-child pair in this directory splits that way: a failing
// expectation should name a value, not a child process's exit code.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

const TEMP_PROJECTS = `/tmp/agentoo-idea-handoff-recovery-test-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-idea-handoff-recovery-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: cluster.connectionString,
      // Deliberately dead, and never dialled: the child fakes ioredis, bullmq
      // and the event bus. `@/env` still insists on a value.
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: TEMP_PROJECTS,
      ATTACHMENTS_DIR: TEMP_ATTACHMENTS,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-handoff-recovery-db-child.ts')], {
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
      const failure = stdout.slice(stdout.indexOf('__ERROR__')) || stderr.slice(-6000)
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
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
  await rm(TEMP_ATTACHMENTS, { recursive: true, force: true })
})

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

test('the scenarios ran at all, against a real Postgres', () => {
  expect(postgresBinDir()).toBeTruthy()
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'crashBetweenClaimWrites',
    'duplicateUploadResponse',
    'filenameReconciliation',
    'stuckPendingPromptRegenerates',
  ])
})

// --- D1: a crash between claimIdeaForHandoff's own two writes ---------------

const dbTest = hasPostgres ? test : test.skip

dbTest('within the grace window, a promptId-less claim is left alone, not stranded', () => {
  const f = fact('crashBetweenClaimWrites')
  // Indistinguishable, for one tick, from an ordinary claim still in
  // flight — so nothing is claimed, dispatched or failed yet.
  expect(f.immediateSweep).toEqual({ claimed: 0, dispatched: 0, failed: 0 })
  expect(f.immediateRunOpen).toBe(true)
  expect(f.immediateRunStatus).toBe('generating')
})

dbTest('past the grace window, the sweep closes it needs_attention itself', () => {
  const f = fact('crashBetweenClaimWrites')
  expect(f.sweepPastGrace).toEqual({ claimed: 0, dispatched: 0, failed: 1 })
  expect(f.runAfterGraceStatus).toBe('closed')
  expect(f.runAfterGraceOutcome).toBe('needs_attention')
  expect(f.runAfterGraceClosed).toBe(true)
  // The card itself is left exactly where it was, with an explanation —
  // never silently reasserted to some other status.
  expect(f.ideaStatusAfterGrace).toBe('selected_for_development')
  expect(typeof f.ideaLastErrorAfterGrace).toBe('string')
  expect(String(f.ideaLastErrorAfterGrace).length).toBeGreaterThan(0)
})

dbTest('...and the existing retry gate gives the card a real way out', () => {
  const f = fact('crashBetweenClaimWrites')
  // The governing requirement: no state may be a dead end. Once the user
  // does anything to the idea, the very next sweep claims it again — a
  // second, brand-new run, not the same one reopened.
  expect(f.sweepAfterRemedy).toEqual({ claimed: 1, dispatched: 0, failed: 0 })
  expect(f.runCountAfterRemedy).toBe(2)
  expect(f.newRunClaimed).toBe(true)
})

// --- D2: the documented remedy for a stuck-pending prompt now works --------

dbTest('a prompt stuck pending leaves the run open and undispatched, as documented', () => {
  const f = fact('stuckPendingPromptRegenerates')
  expect(f.stalePromptStatus).toBe('pending')
  expect(f.sweepWhileStuck).toEqual({ claimed: 0, dispatched: 0, failed: 0 })
  expect(f.runWhileStuckStatus).toBe('generating')
  expect(f.runWhileStuckPromptIsStale).toBe(true)
})

dbTest('regenerating re-points the open run before the next sweep even runs', () => {
  const f = fact('stuckPendingPromptRegenerates')
  expect(f.runRepointedBeforeSweep).toBe(true)
})

dbTest('...so the next sweep actually dispatches, not just generates a prompt nobody reads', () => {
  const f = fact('stuckPendingPromptRegenerates')
  expect(f.sweepAfterRegenerate).toEqual({ claimed: 0, dispatched: 1, failed: 0 })
  expect(f.runStatusAfterSweep).toBe('running')
  expect(f.runPromptIdIsRegenerated).toBe(true)
  expect(f.ideaStatusAfter).toBe('in_progress_dev')
  expect(f.ideaLastErrorAfter).toBe(null)
  expect(f.sessionIdSet).toBe(true)
})

// --- D3: the agent is never told to read a filename absent from its uploads -

dbTest('the checksum collision still dedups — only one session file exists', () => {
  const f = fact('filenameReconciliation')
  expect(f.sessionFilenames).toEqual(['screenshot.txt'])
})

dbTest('...and the prompt sent is reconciled: every name it points at is real', () => {
  const f = fact('filenameReconciliation')
  const text = String(f.sentText)
  const sessionFilenames = f.sessionFilenames as string[]

  // The instruction's own wording survives untouched...
  expect(text).toContain('Read diagram.txt before you start.')
  // ...but a note now says what that name actually resolves to.
  expect(text).toContain('"diagram.txt" is available in this session as "screenshot.txt"')

  // The governing invariant, checked mechanically rather than by trusting the
  // wording above: every idea-side filename the text names is either itself
  // present in the session, or the text explains what it is available as —
  // and that replacement name really is present. No filename may be left for
  // the agent to open that resolves to nothing on disk.
  const renamed = new Map(
    [...text.matchAll(/"([^"]+)" is available in this session as "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  )
  for (const mentioned of ['diagram.txt', 'screenshot.txt']) {
    if (!text.includes(mentioned)) continue
    const resolvesTo = renamed.get(mentioned) ?? mentioned
    expect(sessionFilenames).toContain(resolvesTo)
  }
})

// --- D4: an upload response contradicts the request -------------------------

dbTest('an upload matching an existing checksum says so, honestly', () => {
  const f = fact('duplicateUploadResponse')
  expect(f.firstMatchedExisting).toBe(false)
  expect(f.secondMatchedExisting).toBe(true)
  // Unchanged behaviour — still the dedup's own filename, not the one just
  // sent — now just labelled for what it is.
  expect(f.secondOriginalFilename).toBe('alpha.txt')
  expect(f.rowCount).toBe(2)
})

dbTest('...and a genuinely new upload is not mislabelled either', () => {
  const f = fact('duplicateUploadResponse')
  expect(f.freshMatchedExisting).toBe(false)
})
