// The Idea Manager's whole loop, and the seams between the pieces that build
// it — against a real Postgres.
//
// idea-handoff.test.ts covers the handoff's own decisions and
// turn-outcome-truth.test.ts covers a real turn's outcome; neither joins the
// two. See idea-loop-db-child.ts for what is real here and what is faked (the
// SDK, BullMQ, the event bus, runner-options — nothing else), and for the
// fixtures behind each fact below.
//
// Every assertion lives here rather than in the child, for the same reason
// every other db-child pair in this directory splits that way: a failing
// expectation should name a value, not a child process's exit code.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname

// The child writes real bytes: project checkouts, idea uploads, session
// uploads and ATTACHMENTS.md. Keyed on this process's pid so two overlapping
// runs of this suite cannot share a tree, and removed in afterAll rather than
// left in /tmp for the next reboot to deal with. Passed to the child's own
// environment, never set on this process's — `@/env` parses process.env once
// per process and ATTACHMENTS_DIR defaults to the real attachment store on a
// deployed box, so mutating it here would point this file's own imports at
// production data (see setup-env.ts's header).
const TEMP_PROJECTS = `/tmp/agentoo-idea-loop-test-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-idea-loop-test-attachments-${process.pid}`
const TEMP_LIBRARY = `/tmp/agentoo-idea-loop-test-library-${process.pid}`

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
      // Deliberately a path that does not exist: library/idea-prompt.ts reads
      // `${LIBRARY_DIR}/prompts/idea-to-prompt.md` fresh on every generation,
      // and the default is the real deployed library on this box. Pointed
      // elsewhere so the child exercises the built-in fallback rather than
      // whatever an operator has edited into production.
      LIBRARY_DIR: TEMP_LIBRARY,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      LOG_LEVEL: '1',
    }

    const child = Bun.spawn(['bun', join(BACKEND, 'tests/idea-loop-db-child.ts')], {
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
  await Promise.all(
    [TEMP_PROJECTS, TEMP_ATTACHMENTS, TEMP_LIBRARY].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  )
})

const fact = <T = Record<string, unknown>>(key: string): T => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  return value as T
}

// The guard. Asserted, not warned past: this box has a Postgres server
// installed, so a scenario that did not run is a setup failure to investigate,
// and every other test in this file reads a fact the child produced — a silent
// skip here would turn all of them green while proving nothing.
test('the scenarios ran at all, against a real Postgres', () => {
  expect(postgresBinDir()).toBeTruthy()
  expect(setupError).toBe('')
  expect(Object.keys(facts).sort()).toEqual([
    'announcedLate',
    'announcement',
    'checksumCollision',
    'followupAsset',
    'fullLoop',
    'idempotency',
    'longChain',
    'realChain',
    'strandedAtClaim',
    'strandedOnPendingPrompt',
  ])
})

// --- (a) the whole loop, step by step ----------------------------------------

test('steps 1-2: a new card starts in backlog and the move lands it selected_for_development', () => {
  const f = fact('fullLoop')
  expect(f.statusOnCreate).toBe('backlog')
  expect(f.statusOnMove).toBe('selected_for_development')
})

test('step 2: the sweep claims the card, generates one pending prompt, and does not move it', () => {
  const f = fact('fullLoop')
  expect(f.claimSweep).toEqual({ claimed: 1, dispatched: 0, failed: 0 })
  expect(f.promptCountAfterClaim).toBe(1)
  expect(f.promptStatusAfterClaim).toBe('pending')
  expect(f.promptJobsQueued).toBe(1)
  // The card only moves once a prompt has actually been sent — not on claim.
  expect(f.statusAfterClaim).toBe('selected_for_development')
})

test('step 2: the generation worker turns that row ready, title, prompt and assumptions', () => {
  const f = fact('fullLoop')
  expect(f.promptJobsRun).toBe(1)
  expect(f.promptStatusAfterGeneration).toBe('ready')
  expect(f.promptGeneratedTitle).toBe('Export button in the toolbar')
  expect(f.promptAssumptions).toEqual(['Assumed the button belongs next to Save.'])
  expect(f.promptModel).toBe('claude-test-model')
})

test('step 3: the next tick dispatches — one session, titled from the generated title', () => {
  const f = fact('fullLoop')
  expect(f.dispatchSweep).toEqual({ claimed: 0, dispatched: 1, failed: 0 })
  expect(f.sessionCountAfterDispatch).toBe(1)
  expect(f.sessionTitle).toBe('Export button in the toolbar')
  // The card carries these because its session does not exist until now
  // (db/schema.ts's own comment on ideas.session_id) — chosen up front on the
  // idea, applied here.
  expect(f.sessionOrchestrator).toBe('coder')
  expect(f.sessionMaxBudgetUsd).toBe(7)
})

test('step 3: both assets are copied into that session and the card moves to in_progress_dev', () => {
  const f = fact('fullLoop')
  expect(f.copiedFilenames).toEqual(['layout-notes.txt', 'mock.png'])
  expect(f.firstRunStatus).toBe('running')
  expect(f.firstRunPromptMessageIdSet).toBe(true)
  expect(f.statusAfterDispatch).toBe('in_progress_dev')
})

test('step 4: a clean turn ends, and the turn-ended event advances the card to verification', () => {
  const f = fact('fullLoop')
  expect(f.turnJobsRun).toBe(1)
  expect(f.turnEndedOutcomes).toEqual(['completed'])
  expect(f.firstRunOutcome).toBe('finished')
  expect(f.firstRunDetail).toBe('Added the export button and wired it up.')
  expect(f.statusAfterFirstTurn).toBe('verification')
  expect(f.lastErrorAfterFirstTurn).toBe(null)
})

test('step 5: continue consumes the feedback comments and opens a followup run', () => {
  const f = fact('fullLoop')
  expect(f.continueError).toBe('')
  expect(f.commentCount).toBe(2)
  expect(f.commentsConsumed).toBe(2)
  expect(f.runCountAfterContinue).toBe(2)
  expect(f.followupRunKind).toBe('followup')
})

test('step 5: the followup is dispatched into the SAME session, not a second one', () => {
  const f = fact('fullLoop')
  expect(f.followupSweep).toEqual({ claimed: 0, dispatched: 1, failed: 0 })
  // The whole point of this test: a second session here would be the bug.
  expect(f.sessionCountAfterFollowup).toBe(1)
  expect(f.sessionIdUnchanged).toBe(true)
  expect(f.followupRunSessionIsSame).toBe(true)
  expect(f.statusAfterFollowupDispatch).toBe('in_progress_dev')
  expect(f.promptMessageTexts).toEqual([
    'Add an export button beside Save. Read layout-notes.txt and mock.png first.',
    'Move the export button to the left of Save and add a keyboard shortcut.',
  ])
})

test('step 6: the followup finishes, and the user marks the card done', () => {
  const f = fact('fullLoop')
  expect(f.statusAfterSecondTurn).toBe('verification')
  expect(f.followupRunOutcome).toBe('finished')
  expect(f.statusAfterDone).toBe('done')
  expect(f.runCountAtEnd).toBe(2)
  expect(f.openRunsAtEnd).toBe(0)
})

// --- (b) the consequence of the asset-copy ordering --------------------------
//
// idea-handoff.test.ts asserts the call *order* (attach before send). What
// matters downstream is that the announcement a real turn computes inside its
// own claim transaction actually names those files — a session_files row
// landing after the prompt is announced a whole turn late.

test('the announcement the agent is actually given names both copied assets', () => {
  const f = fact('announcement')
  // Exactly two turns ran across the whole loop: the handoff's and the
  // follow-up's. A third would mean something re-queued itself.
  expect(f.turnPromptCount).toBe(2)
  const prompt = String(f.firstTurnPrompt)
  expect(prompt).toContain('[attachments added] 2 files are now available')
  expect(prompt).toContain('layout-notes.txt')
  expect(prompt).toContain('mock.png')
  // The absolute path an agent can actually Read, not a name composed from
  // originalFilename (see manifest.ts's pathOf).
  for (const stored of f.copiedStoredNames as string[]) {
    expect(prompt).toContain(`${String(f.uploadsDir)}/${stored}`)
  }
})

test('...in the very same turn as the handoff prompt, not the one after it', () => {
  const f = fact('announcement')
  const prompt = String(f.firstTurnPrompt)
  // The announcement is prepended to the prompt text: one turn, both.
  expect(prompt).toContain('Add an export button beside Save.')
  expect(prompt.indexOf('[attachments added]')).toBeLessThan(
    prompt.indexOf('Add an export button beside Save.'),
  )
  // Both rows were stamped by that first turn's own seq, so the follow-up turn
  // has nothing left to announce.
  expect(f.announcedSeqs).toEqual([0, 0])
  expect(String(f.secondTurnPrompt)).not.toContain('[attachments added]')
})

test('the control: an asset copied AFTER the prompt is announced a whole turn late', () => {
  const f = fact('announcedLate')
  // Same fixture as the two tests above, one thing changed. If this passed
  // *and* the "before" case above passed, neither would be telling us
  // anything about ordering.
  expect(String(f.firstTurnPrompt)).toBe('Read late.txt and get on with it.')
  expect(String(f.firstTurnPrompt)).not.toContain('[attachments added]')
  expect(String(f.secondTurnPrompt)).toContain('[attachments added] 1 file is now available')
  expect(String(f.secondTurnPrompt)).toContain('late.txt')
})

// --- (c) idempotency across the seams ----------------------------------------

test('a re-upload of identical bytes returns the existing asset, and adds no row', () => {
  const f = fact('idempotency')
  expect(f.ideaFileRowCount).toBe(2)
  // Deliberately recorded: the dedup is keyed on checksum alone, so the DTO
  // that comes back carries the FIRST upload's filename, not the one just sent.
  expect(f.reUploadReturnedExistingName).toBe('alpha.txt')
})

test('...and a second live idea_files row with the same checksum is impossible', () => {
  const f = fact('idempotency')
  expect(String(f.duplicateRowError)).toContain('idea_files_idea_checksum_key')
})

test('a second handoff of the same idea does not duplicate its assets in the session', () => {
  const f = fact('idempotency')
  expect(f.firstAttachCount).toBe(2)
  expect(f.secondAttachCount).toBe(2)
  expect(f.attachedNames).toEqual(['alpha.txt', 'bravo.txt'])
})

test('...nor does a genuinely concurrent double handoff', () => {
  const f = fact('idempotency')
  expect(f.concurrentAttachCount).toBe(2)
  // A lost onConflictDoNothing is allowed to leave an unrowed blob behind (the
  // GC reaps it); it is never allowed to leave a row whose blob is missing.
  expect(f.rowsWithMissingBlob).toBe(0)
  // Two rows' blobs plus ATTACHMENTS.md at minimum, and one extra copy per
  // asset whenever a race actually happened — which one wins is genuinely
  // nondeterministic, so only the floor is asserted.
  expect(f.blobCountOnDisk as number).toBeGreaterThanOrEqual(3)
})

test('an asset added after the first run is announced by the follow-up turn itself', () => {
  const f = fact('followupAsset')
  expect(f.statusAfterFirstRun).toBe('verification')
  expect(f.statusAtEnd).toBe('verification')
  expect(f.sessionFilenames).toEqual(['first.txt', 'second.txt'])
  const second = String(f.secondTurnPrompt)
  // The new asset reached the session before the follow-up prompt message, so
  // the follow-up turn's own announcement names it — not the turn after it.
  expect(second).toContain('[attachments added] 1 file is now available')
  expect(second).toContain('second.txt')
  expect(second).toContain('Now read second.txt and finish.')
  // ...and the already-announced one is not repeated.
  expect(second).not.toContain('first.txt')
  expect(f.announcedBy).toEqual([
    { name: 'first.txt', seq: 0 },
    { name: 'second.txt', seq: 2 },
  ])
  expect(f.promptSeqs).toEqual([0, 2])
})

test('an idea asset whose bytes already exist in the session is not copied again', () => {
  const f = fact('checksumCollision')
  expect(f.sessionFileCount).toBe(1)
  // The user's own upload wins the (session_id, checksum) index; the idea's
  // filename never lands in the session at all.
  expect(f.sessionFilenames).toEqual(['screenshot.txt'])
})

test('...which leaves the agent told about a name the prompt never mentions', () => {
  const f = fact('checksumCollision')
  const prompt = String(f.turnPrompt)
  // Documented intent (files.ts's attachIdeaAssetsToSession docblock), and
  // recorded here as the observable consequence rather than the intent: the
  // prompt names diagram.txt, and the session has no such file.
  expect(prompt).toContain('Read diagram.txt before you start.')
  expect(prompt).toContain('screenshot.txt')
  expect(prompt).not.toContain('-diagram.txt')
})

// --- (d) the continuation chain ----------------------------------------------

test('a real auto-continuation keeps the same run open and the card unmoved', () => {
  const f = fact('realChain')
  const steps = f.steps as { outcomes: string[]; runOpen: boolean; ideaStatus: string }[]
  expect(steps.length).toBe(2)
  for (const [i, step] of steps.entries()) {
    expect([i, step.outcomes]).toEqual([i, ['continuing']])
    expect([i, step.runOpen]).toEqual([i, true])
    expect([i, step.ideaStatus]).toEqual([i, 'in_progress_dev'])
  }
})

test('...and the run closes on the tail of that chain, several hops from its root', () => {
  const f = fact('realChain')
  expect(f.finalOutcomes).toEqual(['completed'])
  expect(f.finalRunOutcome).toBe('finished')
  expect(f.finalRunStatus).toBe('closed')
  expect(f.finalIdeaStatus).toBe('verification')
  expect(f.finalRunDetail).toBe('All of it is done.')
})

test('...over a chain the transcript alone can reconstruct', () => {
  const f = fact('realChain')
  expect(f.chainLength).toBe(3)
  expect(f.rootIsRunRoot).toBe(true)
  expect(f.chainLinks).toEqual([
    { auto: false, continues: null, outcome: 'continuing' },
    { auto: true, continues: 0, outcome: 'continuing' },
    { auto: true, continues: 1, outcome: 'completed' },
  ])
})

test('a chain longer than the auto-continuation budget still closes correctly', () => {
  const f = fact('longChain')
  expect(f.hops).toBe(7)
  // Not one of the seven mid-chain turns closes the run or moves the card —
  // including the fourth, fifth, sixth and seventh, past MAX_AUTO_CONTINUATIONS.
  expect(f.openThroughChain).toEqual([true, true, true, true, true, true, true])
  expect(f.statusThroughChain).toEqual(Array(7).fill('in_progress_dev'))
  expect(f.closedOutcome).toBe('finished')
  expect(f.closedStatus).toBe('closed')
  expect(f.closedDetail).toBe('Finished on hop 7.')
  expect(f.ideaStatusAfterTail).toBe('verification')
})

test("a turn ending outside the run's own chain does not close it", () => {
  const f = fact('longChain')
  expect(f.offChainRunStillOpen).toBe(true)
  expect(f.offChainIdeaStatus).toBe('in_progress_dev')
})

// --- (e) the failure injection ------------------------------------------------
//
// Both scenarios reproduce a real defect against Postgres — see the report
// accompanying this file. D1 (the claim's own crash window) is fixed by a
// grace window in features/ideas/handoff.ts's progressOpenRuns, which needs
// real wall-clock time to elapse before it closes the run; nothing below
// advances the clock, so what these three back-to-back sweeps observe is
// still the immediate, no-time-has-passed state, unchanged by the fix — the
// eventual recovery past that window is covered separately, in
// idea-handoff-recovery.test.ts, which does advance it. D2 (a stuck-pending
// prompt's regenerate) is fixed synchronously — createIdeaPrompt now
// re-points the open run at the fresh prompt it just generated — so the
// second test below changed from documenting the defect to confirming the
// fix, exactly as this section's tests are meant to when one lands.

test("a crash between the claim's two writes strands the card, absent the grace window", () => {
  const f = fact('strandedAtClaim')
  // Three sweeps, and then one after every documented remedy: nothing is ever
  // claimed, dispatched or failed — none of this test's own remedies touch
  // the clock, so IDEA_HANDOFF_CLAIM_GRACE_MS (env.ts) has not elapsed yet.
  expect(f.sweeps).toEqual([
    { claimed: 0, dispatched: 0, failed: 0 },
    { claimed: 0, dispatched: 0, failed: 0 },
    { claimed: 0, dispatched: 0, failed: 0 },
  ])
  expect(f.sweepAfterRemedy).toEqual({ claimed: 0, dispatched: 0, failed: 0 })
  expect(f.sweepAfterReMove).toEqual({ claimed: 0, dispatched: 0, failed: 0 })
  // The run is still open, still promptId-less, and the reconciler will not
  // touch it (it only looks at `running` rows).
  expect(f.orphanReconciled).toBe(0)
  expect(f.runStatus).toBe('generating')
  expect(f.runOpen).toBe(true)
  expect(f.runPromptIdNull).toBe(true)
  // The card is on selected_for_development with nothing to explain itself,
  // and no session or prompt was ever created.
  expect(f.ideaStatus).toBe('selected_for_development')
  expect(f.ideaLastError).toBe(null)
  expect(f.promptCount).toBe(0)
  expect(f.sessionCount).toBe(0)
})

test('...and every operator remedy is refused or ignored, within that window', () => {
  const f = fact('strandedAtClaim')
  expect(String(f.deleteError)).toContain('handoff in progress')
  expect(String(f.continueError)).toContain('no completed run yet')
  // Re-moving the card is accepted (it bumps updatedAt) and still changes
  // nothing, because the open run is what blocks the claim.
  expect(f.reMoveError).toBe('')
})

test('a prompt stuck pending no longer strands the run: regenerating actually frees it', () => {
  const f = fact('strandedOnPendingPrompt')
  expect(f.stalePromptStatus).toBe('pending')
  expect(f.sweepWithPendingPrompt).toEqual({ claimed: 0, dispatched: 0, failed: 0 })
  expect(f.runStatusWhilePending).toBe('generating')
  // The documented remedy runs, and its new prompt really does reach `ready`.
  expect(f.promptStatuses).toEqual(['pending', 'ready'])
  expect(f.regeneratedIsReady).toBe(true)
  // createIdeaPrompt re-points the open run at the row it just generated —
  // no longer left pointing at the one it superseded.
  expect(f.runPromptIdIsStale).toBe(false)
  // ...so the very next sweep dispatches on the spot: a real session, the
  // card moved off selected_for_development, nothing left needing attention.
  expect(f.sweepAfterRegenerate).toEqual({ claimed: 0, dispatched: 1, failed: 0 })
  expect(f.runStatusAfter).toBe('running')
  expect(f.runOpenAfter).toBe(true)
  expect(f.ideaStatusAfter).toBe('in_progress_dev')
  expect(f.ideaLastErrorAfter).toBe(null)
  expect(f.sessionCount).toBe(1)
})
