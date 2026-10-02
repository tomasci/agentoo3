// Independent verification of session learning against a real Postgres, a
// real scratch LIBRARY_DIR and the real HTTP app (SDK, bullmq and ioredis
// faked) — see learning-verify-db-child.ts for every fixture. Grouped by the
// requirement each check is evidence for.

import { afterAll, describe, expect, test } from 'bun:test'
import './setup-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKEND, type ChildResult, factReader, runChild } from './learning-verify-harness'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const hasPostgres = Boolean(postgresBinDir())
let cluster: Cluster | undefined
let nocredCluster: Cluster | undefined
let root = ''
let main: ChildResult = { facts: {}, error: 'not run' }
let nocred: ChildResult = { facts: {}, error: 'not run' }

if (hasPostgres) {
  try {
    root = await mkdtemp(join(tmpdir(), 'agentoo-learning-verify-'))
    ;[cluster, nocredCluster] = await Promise.all([
      startTempCluster(join(BACKEND, 'src/db/migrations')),
      startTempCluster(join(BACKEND, 'src/db/migrations')),
    ])
    const common = {
      REDIS_URL: 'redis://127.0.0.1:1',
      PROJECTS_DIR: join(root, 'projects'),
      ATTACHMENTS_DIR: join(root, 'attachments'),
      VERIFY_ROOT: join(root, 'lib'),
      LIBRARY_DIR: join(root, 'lib', 'library'),
      LEARNING_BATCH_CHARS: '60000',
    }
    ;[main, nocred] = await Promise.all([
      runChild('learning-verify-db-child.ts', {
        ...common,
        DATABASE_URL: cluster.connectionString,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
      }),
      runChild('learning-verify-db-child.ts', {
        ...common,
        VERIFY_ROOT: join(root, 'nocred'),
        LIBRARY_DIR: join(root, 'nocred', 'library'),
        DATABASE_URL: nocredCluster.connectionString,
        VERIFY_MODE: 'nocred',
      }),
    ])
  } catch (error) {
    main = { facts: {}, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
}

afterAll(async () => {
  await Promise.all([cluster?.stop(), nocredCluster?.stop()])
  if (root) await rm(root, { recursive: true, force: true })
})

const dbTest = hasPostgres ? test : test.skip
const fact = factReader(() => main)
const nocredFact = factReader(() => nocred)

dbTest('the child ran every scenario without throwing', () => {
  expect(main.error).toBe('')
  expect(main.facts.stepErrors).toEqual({})
  expect(nocred.error).toBe('')
})

// --- 1. schedule setting ------------------------------------------------------

describe('req 1: schedule setting over HTTP', () => {
  dbTest('GET /system/settings with nothing saved: default 04:00 UTC, source default', () => {
    const f = fact('settings')
    expect(f.initialStatus).toBe(200)
    expect(f.initialValue).toEqual({ enabled: true, time: '04:00', timezone: 'UTC' })
    expect(f.initialDefault).toEqual({ enabled: true, time: '04:00', timezone: 'UTC' })
    expect(f.initialSource).toBe('default')
  })

  dbTest('nextRunAt for the default is the next 04:00 UTC per an Intl oracle (04:00Z)', () => {
    const f = fact('settings')
    expect(f.initialNextRunAt).toBe(f.expectedInitialNextRunAt)
    expect(String(f.initialNextRunAt)).toEndWith('T04:00:00.000Z')
  })

  dbTest('GET /library/learning reports the same default schedule and nextRunAt', () => {
    const f = fact('settings')
    expect(f.overview0Schedule).toEqual({ value: f.initialValue, nextRunAt: f.initialNextRunAt })
  })

  for (const name of [
    'time 24:00',
    'time 4:00',
    'time 04:60',
    'time 04:00:00',
    'unknown timezone',
    'empty timezone',
    'missing time',
    'missing timezone',
    'missing enabled',
    'enabled as string',
    'schedule as string',
    'empty object',
  ]) {
    dbTest(`PATCH learningSchedule (${name}) is a 400 with an error message`, () => {
      const invalid = fact('settings').invalid as Record<string, { status: number; hasError: boolean }>
      expect(invalid[name]).toEqual({ status: 400, hasError: true })
    })
  }

  dbTest('no invalid PATCH stored anything', () => {
    const f = fact('settings')
    expect(f.rowAfterInvalid).toBeNull()
    expect(f.afterInvalidSource).toBe('default')
  })

  dbTest('PATCH a valid schedule: echoed, read back, source override, nextRunAt per oracle', () => {
    const f = fact('settings')
    const custom = { enabled: true, time: '05:30', timezone: 'Asia/Jerusalem' }
    expect(f.patchCustomStatus).toBe(200)
    expect(f.patchCustomEcho).toEqual(custom)
    expect(f.getCustomValue).toEqual(custom)
    expect(f.getCustomSource).toBe('override')
    expect(f.getCustomNextRunAt).toBe(f.expectedCustomNextRunAt)
    expect(f.overviewCustomSchedule).toEqual({ value: custom, nextRunAt: f.expectedCustomNextRunAt })
  })

  dbTest('PATCH of maxConcurrentSessions alone leaves the schedule untouched', () => {
    expect(fact('settings').patchOtherScheduleValue).toEqual({ enabled: true, time: '05:30', timezone: 'Asia/Jerusalem' })
  })

  dbTest('PATCH enabled:false: nextRunAt is null in both views', () => {
    const f = fact('settings')
    expect(f.patchDisabledStatus).toBe(200)
    expect(f.patchDisabledNextRunAt).toBeNull()
    expect((f.overviewDisabledSchedule as { nextRunAt: unknown }).nextRunAt).toBeNull()
  })

  dbTest('PATCH learningSchedule:null resets to the default and deletes the row', () => {
    const f = fact('settings')
    expect(f.patchNullStatus).toBe(200)
    expect(f.patchNullValue).toEqual({ enabled: true, time: '04:00', timezone: 'UTC' })
    expect(f.patchNullSource).toBe('default')
    expect(f.patchNullNextRunAt).toBe(f.expectedResetNextRunAt)
    expect(f.rowAfterReset).toBeNull()
    expect((f.overviewResetSchedule as { nextRunAt: unknown }).nextRunAt).toBe(f.expectedResetNextRunAt)
  })
})

// --- 2. window ----------------------------------------------------------------

describe('req 2: window', () => {
  dbTest('manual run: windowEnd is the moment of the request, windowStart exactly 24h earlier', () => {
    const f = fact('manualRun')
    expect(f.firstStatus).toBe(202)
    expect(f.trigger).toBe('manual')
    expect(f.windowEndMs as number).toBeGreaterThanOrEqual(f.before as number)
    expect(f.windowEndMs as number).toBeLessThanOrEqual(f.after as number)
    expect((f.windowEndMs as number) - (f.windowStartMs as number)).toBe(24 * 3_600_000)
  })

  dbTest('scheduled trigger processed months late: windowEnd is exactly the 04:00:00+03:00 occurrence from prevMillis', () => {
    const f = fact('window')
    expect(f.scheduledRows).toBe(1)
    expect(f.windowEnd).toBe(f.expectedWindowEnd)
    expect(f.windowStart).toBe(f.expectedWindowStart)
  })

  dbTest('boundaries: T-24h and T-24h+1ms and T-1ms are in; T-24h-1ms, T and T+1ms are out', () => {
    const f = fact('window')
    expect(f.presence).toEqual(f.expected)
    expect(f.sessionsAnalyzed).toBe(4)
    expect(f.status).toBe('completed')
  })

  dbTest('sessions from all three projects in the window reach the review call', () => {
    expect(fact('window').projectsInPrompt).toEqual(['win-a', 'win-b', 'win-c'])
  })

  dbTest('a trigger with neither prevMillis nor timestamp/delay falls back to the last 04:00 UTC occurrence, not now', () => {
    const f = fact('window')
    expect(String(f.fallbackWindowEnd)).toEndWith('T04:00:00.000Z')
    expect(f.fallbackNotAfterNow).toBe(true)
    expect(f.fallbackWithinADay).toBe(true)
  })
})

// --- 3. queue (DB side; the real-Redis side is learning-verify-queue) ---------

describe('req 3: queue and single active run', () => {
  dbTest('a manual run is enqueued on session-run as job "learning" with jobId learning-<runId>', () => {
    const f = fact('manualRun')
    expect(f.enqueuedQueue).toBe('session-run')
    expect(f.enqueuedName).toBe('learning')
    expect(f.enqueuedData).toEqual({ learningRunId: f.firstId })
    expect(f.enqueuedJobId).toBe(`learning-${f.firstId}`)
  })

  dbTest('a second manual trigger while one is queued is a 409 naming the active run', () => {
    const f = fact('manualRun')
    expect(f.secondStatus).toBe(409)
    expect(String(f.secondError)).toContain(String(f.firstId))
    expect(f.overviewActiveId).toBe(f.firstId)
  })

  dbTest('eight concurrent manual triggers: exactly one 202, seven 409, one active row, one enqueue', () => {
    const f = fact('manualRun')
    expect(f.burstStatuses).toEqual([202, 409, 409, 409, 409, 409, 409, 409])
    expect(f.burstActiveRows).toBe(1)
    expect(f.burstEnqueued).toBe(1)
  })

  dbTest('a scheduled trigger that collides with an active manual run is skipped: no row, no throw, manual run untouched', () => {
    const f = fact('window')
    expect(f.collisionThrew).toBe(false)
    expect(f.collisionRows).toBe(0)
    expect(f.manualStillActive).toBe('queued')
  })

  dbTest('a redelivered scheduled trigger for the same occurrence creates no second row', () => {
    expect(fact('window').rowsAfterRedelivery).toBe(1)
  })

  dbTest('a duplicate job delivery (two concurrent runLearning + a late third) runs the review exactly once', () => {
    const f = fact('robustness').dupDelivery as { reviewCalls: number; status: string }
    expect(f.reviewCalls).toBe(1)
    expect(f.status).toBe('completed')
  })
})

// --- 4. library read first ----------------------------------------------------

describe('req 4: the review call contains the whole library', () => {
  dbTest('every agent file, byte for byte as on disk (including a hand-written one), is in the prompt', () => {
    expect(fact('engine').promptHasEveryAgentVerbatim).toEqual({ scout: true, reviewer: true, handmade: true })
  })

  dbTest('every skill SKILL.md, byte for byte, is in the prompt, with bundled file names', () => {
    const f = fact('engine')
    expect(f.promptHasEverySkillVerbatim).toEqual({ triage: true, deploy: true })
    expect(f.promptNamesTriageExtraFile).toBe(true)
  })

  dbTest('the review call is tool-less and uses the operator-editable instruction', () => {
    const f = fact('engine')
    expect(f.reviewOptionsTools).toEqual([])
    expect(f.systemPromptIsOperatorInstruction).toBe(true)
    expect(f.promptHasSession).toBe(true)
  })
})

// --- 5. never auto-modify -----------------------------------------------------

describe('req 5: a run never writes to LIBRARY_DIR', () => {
  dbTest('every file and directory under the library root is byte-identical after a run that created modify and create suggestions', () => {
    const f = fact('engine')
    expect(f.insertedNames as string[]).toContain('agent:modify:scout')
    expect(f.insertedNames as string[]).toContain('skill:create:release-notes')
    expect(f.treeFileCount as number).toBeGreaterThan(8)
    expect(f.treeDiff).toEqual([])
  })
})

// --- 6. suggestions and decisions ---------------------------------------------

describe('req 6: suggestions and decisions', () => {
  const d = () => fact('decisions')

  dbTest('list by status works, default is pending, an unknown status is a 400', () => {
    expect(d().pendingListStatus).toBe(200)
    expect(d().pendingListHasAll).toBe(true)
    expect(d().defaultListStatus).toBe(200)
    expect(d().bogusStatusQuery).toBe(400)
  })

  dbTest('detail carries currentMarkdown (= disk), currentHash (= sha256 of disk) and a differing proposedMarkdown', () => {
    expect(d().detailStatus).toBe(200)
    expect(d().detailCurrentIsDisk).toBe(true)
    expect(d().detailHashIsSha).toBe(true)
    expect(d().detailProposedDiffers).toBe(true)
    expect(d().detailProposedHasNewBody).toBe(true)
    expect(d().detailStale).toBe(false)
  })

  dbTest('apply-modify with a stale or null hash: 409, file untouched, still pending, no version rows', () => {
    expect(d().staleStatus).toBe(409)
    expect(d().nullHashStatus).toBe(409)
    expect(d().fileUntouchedAfterStale).toBe(true)
    expect(d().stillPendingAfterStale).toBe('pending')
    expect(d().noVersionsAfterStale).toBe(0)
  })

  dbTest('apply-modify writes the proposal and records snapshot v1 (prior content) + suggestion v2', () => {
    expect(d().goodStatus).toBe(200)
    expect(d().goodBodyStatus).toBe('applied')
    expect(d().goodAppliedVersion).toBe(2)
    expect(d().fileHasNewBody).toBe(true)
    expect(d().fileFrontmatterLines).toEqual(d().shownFrontmatterLines)
    expect(d().versions).toEqual([
      { version: 2, source: 'suggestion', suggestionId: 'this' },
      { version: 1, source: 'snapshot', suggestionId: null },
    ])
    expect(d().snapshotIsOriginal).toBe(true)
    expect(d().suggestionVersionIsFile).toBe(true)
  })

  // The diff a reviewer approves is `proposedMarkdown`; what lands on disk
  // should be exactly those bytes.
  dbTest('apply-modify writes exactly the proposedMarkdown bytes the detail view showed', () => {
    const f = d().fileVsShown as { disk: string; shown: string }
    expect(f.disk).toBe(f.shown)
  })

  dbTest('a "name" smuggled into proposed renames nothing: no hijacked.md or evil-rename.md', () => {
    expect(d().noRenameFile).toBe(true)
    expect(fact('engine').proposedCarriesName).toEqual([])
  })

  dbTest('a second sequential apply is a 409 and writes nothing', () => {
    expect(d().againStatus).toBe(409)
    expect(d().versionsAfterAgain).toBe(2)
    expect(d().fileAfterAgainUnchanged).toBe(true)
  })

  dbTest('apply-modify on a skill keeps its bundled files byte-identical', () => {
    expect(d().triageApplyStatus).toBe(200)
    expect(d().triageSkillMdIsProposed).toBe(true)
    expect(d().triageChecklistKept).toBe(true)
    expect(d().triageScriptKept).toBe(true)
    expect(d().triageVersions).toEqual(['suggestion', 'snapshot'])
  })

  dbTest('apply-create adds the skill at version 1', () => {
    expect(d().notesApplyStatus).toBe(200)
    expect(d().notesFileExists).toBe(true)
    expect(d().notesVersions).toEqual([{ version: 1, source: 'suggestion' }])
  })

  dbTest('apply-create whose name is now taken: 409, existing file untouched, still pending, no versions', () => {
    expect(d().linterApplyStatus).toBe(409)
    expect(d().linterFileUnchanged).toBe(true)
    expect(d().linterStillPending).toBe('pending')
    expect(d().linterVersions).toBe(0)
  })

  dbTest('apply after the target was deleted: detail still 200 (targetExists false), apply 409, not recreated, still pending', () => {
    expect(d().deletedTargetDetailStatus).toBe(200)
    expect(d().deletedTargetExists).toBe(false)
    expect(d().deletedTargetHash).toBeNull()
    expect(d().deletedTargetApplyStatus).toBe(409)
    expect(d().deletedTargetNotRecreated).toBe(true)
    expect(d().deletedTargetStillPending).toBe('pending')
  })

  dbTest('state machine: delete pending/applied 409, reject applied 409, reject -> rejected list, reject again 409, apply rejected 409', () => {
    expect(d().deletePending).toBe(409)
    expect(d().deleteApplied).toBe(409)
    expect(d().rejectApplied).toBe(409)
    expect(d().rejectStatus).toBe(200)
    expect(d().rejectBodyStatus).toBe('rejected')
    expect(d().inRejectedList).toBe(true)
    expect(d().notInPendingList).toBe(true)
    expect(d().rejectAgain).toBe(409)
    expect(d().applyRejected).toBe(409)
  })

  dbTest('DELETE a rejected suggestion: 204, then 404 on GET and on a second DELETE', () => {
    expect(d().deleteRejected).toBe(204)
    expect(d().getAfterDelete).toBe(404)
    expect(d().deleteAgain).toBe(404)
  })

  dbTest('status=applied lists exactly what was applied', () => {
    expect(d().appliedListNames).toEqual(['release-notes', 'scout', 'triage'])
  })

  dbTest('unknown ids are 404 and malformed ids 400 on every endpoint; apply-modify with no body is refused and writes nothing', () => {
    expect(d().unknown).toEqual({ get: 404, apply: 404, reject: 404, delete: 404 })
    expect(d().malformed).toEqual({ get: 400, apply: 400, reject: 400, delete: 400 })
    expect((d().applyWithoutBody as { status: number }).status).toBeGreaterThanOrEqual(400)
    expect((d().applyWithoutBody as { fileUnchanged: boolean }).fileUnchanged).toBe(true)
  })

  dbTest('six concurrent applies of one suggestion: one 200, five 409, one snapshot + one suggestion version', () => {
    expect(d().concurrentStatuses).toEqual([200, 409, 409, 409, 409, 409])
    expect(d().concurrentVersions).toEqual(['suggestion', 'snapshot'])
  })

  dbTest('two different modify suggestions for one item, both reviewed against the same hash, applied concurrently: one wins, and disk, status and history agree (20 trials)', () => {
    const trials = d().raceTrials as { statuses: number[]; consistent: boolean; detail: string }[]
    expect(trials.filter((t) => !t.consistent).map((t) => `${t.statuses.join('/')} ${t.detail}`)).toEqual([])
  })

  // Five were inserted by the engine run; decisions deleted one (the rejected
  // reviewer row) on purpose. Every other row survives the later runs.
  dbTest('suggestions persist across runs', () => {
    expect((fact('dedupe').persisted as { engineRowsStillThere: number }).engineRowsStillThere).toBe(4)
  })
})

// --- adversarial: untrusted model output --------------------------------------

describe('adversarial: model output is untrusted', () => {
  dbTest('only the five valid candidates were inserted, all pending', () => {
    const f = fact('engine')
    expect(f.insertedNames).toEqual([
      'agent:create:linter',
      'agent:modify:reviewer',
      'agent:modify:scout',
      'skill:create:release-notes',
      'skill:modify:triage',
    ])
    expect(f.insertedAllPending).toBe(true)
    expect(f.suggestionsCreated).toBe(5)
    expect(f.status).toBe('completed')
  })

  dbTest('no invalid candidate (traversal, slash, uppercase, overlong, ghost target, existing name, bad effort/maxTurns/role, missing fields) even reached the judge', () => {
    expect(fact('engine').judgeSawNames).toEqual(['linter', 'release-notes', 'reviewer', 'scout', 'triage'])
  })

  dbTest('sourceSessionIds outside the batch are dropped', () => {
    const f = fact('engine')
    expect(f.scoutSources).toEqual([f.inBatch])
  })

  dbTest('a modify records the on-disk content it was proposed against as baseMarkdown', () => {
    expect(fact('engine').scoutBaseIsDisk).toBe(true)
  })

  dbTest('tampered rows with unsafe names: apply never writes outside LIBRARY_DIR and every row stays pending', () => {
    const f = fact('tamper')
    expect(f.treeDiff).toEqual([])
    expect(f.absEscapeCreated).toBe(false)
    const results = f.results as Record<string, { apply: number; statusAfter: string }>
    for (const [name, r] of Object.entries(results)) {
      expect({ name, ok: r.apply >= 200 && r.apply < 300 }).toEqual({ name, ok: false })
      expect({ name, statusAfter: r.statusAfter }).toEqual({ name, statusAfter: 'pending' })
    }
  })

  dbTest('tampered rows with unsafe names: apply answers a 4xx, not a 500', () => {
    const results = fact('tamper').results as Record<string, { apply: number }>
    const fiveHundreds = Object.entries(results)
      .filter(([, r]) => r.apply >= 500)
      .map(([n, r]) => `${n} -> ${r.apply}`)
    expect(fiveHundreds).toEqual([])
  })

  dbTest('one tampered row on file does not take down GET /library/suggestions (or its own detail)', () => {
    const f = fact('tamper')
    expect(f.pendingListStatusAfterCleanup).toBe(200)
    const results = f.results as Record<string, { get: number }>
    const broken = Object.entries(results)
      .filter(([, r]) => r.get >= 500)
      .map(([n, r]) => `detail ${n} -> ${r.get}`)
    expect({ list: f.pendingListStatus, broken }).toEqual({ list: 200, broken: [] })
  })
})

// --- 7. dedupe ------------------------------------------------------------------

describe('req 7: dedupe', () => {
  const dd = () => fact('dedupe')

  dbTest('a reworded duplicate of a pending row: the judge is consulted with that row, it is skipped and counted', () => {
    expect(dd().semantic).toEqual({
      status: 'completed',
      created: 0,
      skipped: 1,
      judgeCalled: true,
      judgeSawExisting: true,
      newRows: 0,
    })
  })

  dbTest('a byte-identical duplicate is skipped without a judge call', () => {
    expect(dd().exact).toEqual({ created: 0, skipped: 1, judgeCalled: false })
  })

  dbTest('a byte-identical duplicate of a pending agent suggestion with optional frontmatter is skipped without a judge call', () => {
    expect(dd().exactAgent).toEqual({ created: 0, skipped: 1, judgeCalled: false })
  })

  dbTest('the judge call failing: nothing from the batch is inserted, and the run says why', () => {
    const f = dd().judgeFails as { created: number; newRows: number; error: string }
    expect(f.created).toBe(0)
    expect(f.newRows).toBe(0)
    expect(f.error).toContain('dedupe judge call failed')
  })

  dbTest('a judge answer of the wrong shape: nothing inserted', () => {
    expect(dd().judgeMalformed).toEqual({ created: 0, newRows: 0 })
  })

  // Fails closed only if a candidate the judge never gave a verdict on is
  // treated as unchecked. features/learning/dedupe.ts treats silence as
  // "not a duplicate" and inserts it — see the report.
  dbTest('a judge answer with no verdict for a candidate: that candidate is not inserted unchecked', () => {
    expect(dd().judgeSilent).toEqual({ created: 0, newRows: 0 })
  })

  dbTest('a rejected row blocks the idea; after DELETE the same idea is proposed again as a new pending row', () => {
    const f = dd().resurface as Record<string, unknown>
    expect(f.firstJudgeSawRejected).toBe(true)
    expect(f.firstReviewPromptListsRejected).toBe(true)
    expect(f.firstCreated).toBe(0)
    expect(f.firstSkipped).toBe(1)
    expect(f.deleteStatus).toBe(204)
    expect(f.secondJudgeSawRejected).toBe(false)
    expect(f.secondCreated).toBe(1)
    expect(f.pendingBisector).toBe(1)
    expect(f.pendingBisectorIsNewRow).toBe(true)
  })
})

// --- 8. robustness ------------------------------------------------------------

describe('req 8: robustness', () => {
  const r = () => fact('robustness')
  type Sweep = { status: string; error: string | null }

  dbTest('running with a stale heartbeat -> failed by the sweep, and a new manual run is then accepted', () => {
    expect((r().staleHeartbeat as Sweep).status).toBe('failed')
    expect((r().staleHeartbeat as Sweep).error).toContain('heartbeat')
    expect(r().postAfterStaleHeartbeat).toBe(202)
  })

  dbTest('running with no heartbeat ever and an old claim -> failed', () => {
    expect((r().nullHeartbeatOldStart as Sweep).status).toBe('failed')
  })

  dbTest('running with a fresh heartbeat, or just claimed, is left alone', () => {
    expect((r().freshHeartbeat as Sweep).status).toBe('running')
    expect((r().justClaimed as Sweep).status).toBe('running')
  })

  dbTest('queued with a waiting or delayed job is left alone; with a settled job -> failed', () => {
    expect((r().queuedWaiting as Sweep).status).toBe('queued')
    expect((r().queuedDelayed as Sweep).status).toBe('queued')
    expect((r().queuedJobCompleted as Sweep).status).toBe('failed')
  })

  dbTest('queued whose job is gone -> failed, and a new manual run is then accepted', () => {
    expect((r().queuedLost as Sweep).status).toBe('failed')
    expect(r().postAfterLost).toBe(202)
  })

  // A sweep that runs in the gap between the run's INSERT and its enqueue
  // (features/learning/runs.ts) sees a queued row with no job yet.
  dbTest('a sweep landing between a run\'s insert and its enqueue does not fail the just-created run', () => {
    const f = r().sweepBeforeEnqueue as { httpStatus: number; reportedStatus: string; rowStatus: string }
    expect(f.httpStatus).toBe(202)
    expect({ reported: f.reportedStatus, row: f.rowStatus }).toEqual({ reported: 'queued', row: 'queued' })
  })

  dbTest('no batch reviewed (malformed answer, or failed call) -> failed with the reason', () => {
    const m = r().malformedReview as Sweep
    const f = r().failedReview as Sweep
    expect(m.status).toBe('failed')
    expect(m.error).toContain('did not match the expected shape')
    expect(f.status).toBe('failed')
    expect(f.error).toContain('review call failed')
  })

  dbTest('no credential -> failed with a clear reason, finished, and no model call', () => {
    const f = nocredFact('noCredential')
    expect(f.hasClaudeCredential).toBe(false)
    expect(f.status).toBe('failed')
    expect(String(f.error)).toContain('No Claude credential')
    expect(f.finishedAt).toBe('set')
    expect(f.sdkCalls).toBe(0)
  })
})
