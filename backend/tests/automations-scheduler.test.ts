// The project-automations sweep (features/automations/scheduler.ts) against a
// real Postgres, real createSession/sendMessage and real git repos — see
// automations-scheduler-db-child.ts for the fixture behind each fact below
// and for what is faked (bullmq, ioredis, the pub/sub bridge). Runs in a child
// process for the `@/env` first-import-wins reason pg-cluster.ts explains.
//
// Every expected instant below is written out by hand, never computed with
// the cron helpers under test.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Cluster, postgresBinDir, startTempCluster } from './pg-cluster'

const BACKEND = new URL('..', import.meta.url).pathname
const TEMP_PROJECTS = `/tmp/agentoo-automations-scheduler-test-projects-${process.pid}`
const TEMP_ATTACHMENTS = `/tmp/agentoo-automations-scheduler-test-attachments-${process.pid}`

type Facts = Record<string, Record<string, unknown>>

let cluster: Cluster | undefined
let facts: Facts = {}
let setupError = ''

const hasPostgres = Boolean(postgresBinDir())

if (hasPostgres) {
  try {
    cluster = await startTempCluster(join(BACKEND, 'src/db/migrations'))
    const child = Bun.spawn(['bun', join(BACKEND, 'tests/automations-scheduler-db-child.ts')], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: cluster.connectionString,
        // Deliberately dead, and never dialled: the child fakes ioredis and bullmq.
        REDIS_URL: 'redis://127.0.0.1:1',
        PROJECTS_DIR: TEMP_PROJECTS,
        ATTACHMENTS_DIR: TEMP_ATTACHMENTS,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-not-a-real-token',
        LOG_LEVEL: '1',
      },
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
  await rm(TEMP_PROJECTS, { recursive: true, force: true })
  await rm(TEMP_ATTACHMENTS, { recursive: true, force: true })
})

/** Skipped, loudly, only when the box has no Postgres server installed at all. */
const dbTest = hasPostgres ? test : test.skip

// biome-ignore lint/suspicious/noExplicitAny: facts are free-form JSON from the child
const fact = (key: string): any => {
  const value = facts[key]
  if (!value) throw new Error(`child produced no "${key}" facts (setupError: ${setupError})`)
  if (typeof value.thrown === 'string') throw new Error(`scenario "${key}" threw: ${value.thrown}`)
  return value
}

test('the scenarios ran at all', () => {
  if (!hasPostgres) {
    console.warn(
      'No Postgres server binaries on this box; the automation sweep scenarios did not run.',
    )
    return
  }
  expect(setupError).toBe('')
  expect(Object.keys(facts).length).toBeGreaterThanOrEqual(16)
})

// --- 1. firing ------------------------------------------------------------------

dbTest('a due automation fires into a new session with its own settings and title', () => {
  const f = fact('firing')
  expect(f.result).toEqual({ claimed: 1, dispatched: 1, failed: 0, staleRecovered: 0 })
  expect(f.createdSessionCount).toBe(1)
  // 08:00Z is 09:00 in Europe/Berlin (CET, UTC+1) on 2 March.
  expect(f.sessionTitle).toBe('Nightly audit · 2026-03-02 09:00')
  expect(f.sessionOrchestrator).toBe('coder')
  expect(f.sessionMaxBudgetUsd).toBe(7)
  expect(f.sessionBaseBranch).toBe('develop')
  expect(f.sessionHasWorktree).toBe(true)
})

dbTest("the automation's prompt is the session's first and only prompt message", () => {
  const f = fact('firing')
  expect(f.messageCount).toBe(1)
  expect(f.firstMessageType).toBe('prompt')
  expect(f.firstMessageText).toBe('Audit the repository and report findings')
  // sendMessage's real path moved the idle session to queued and enqueued a turn.
  expect(f.sessionStatus).toBe('queued')
  expect(f.enqueuedSessionIds).toEqual([f.sessionId])
})

dbTest('firing records a dispatched run row pointing at the session and message', () => {
  const f = fact('firing')
  expect(f.runCount).toBe(1)
  expect(f.runSessionMatches).toBe(true)
  expect(f.runPromptMessageMatches).toBe(true)
  expect(f.runScheduledFor).toBe('2026-03-02T08:00:00.000Z')
  expect(f.runPrompt).toBe('Audit the repository and report findings')
  expect(f.runStatus).toBe('dispatched')
  expect(f.runError).toBeNull()
  expect(f.runCountOnDto).toBe(1)
})

dbTest('firing advances next_run_at past now and stamps last_run_at with the due instant', () => {
  const f = fact('firing')
  expect(f.nextRunAt).toBe('2026-03-03T08:00:00.000Z')
  expect(f.lastRunAt).toBe('2026-03-02T08:00:00.000Z')
})

dbTest(
  'getSession and listSessions report automationId for the session it created, null otherwise',
  () => {
    const f = fact('firing')
    expect(f.getSessionAutomationId).toBe(f.automationId)
    expect(f.listSessionsAutomationId).toBe(f.automationId)
    expect(f.manualSessionAutomationId).toBeNull()
  },
)

dbTest('a firing at local midnight is titled 00:00 of the new local day', () => {
  const f = fact('midnightTitle')
  // 23:00Z on 2 March is 00:00 on 3 March in Berlin.
  expect(f.title).toBe('Midnight · 2026-03-03 00:00')
  expect(f.runCount).toBe(1)
})

// --- 2. always a new session ------------------------------------------------------

dbTest('every firing creates a different session and never touches an earlier one', () => {
  const f = fact('alwaysNew')
  expect(f.s1StatusAfterFirst).toBe('queued')
  expect(f.s1MessagesAfterFirst).toBe(1)
  // Second firing while the first session is still queued.
  expect(f.sessionCountAfterSecond).toBe(2)
  expect(f.s1StatusAfterSecond).toBe('queued')
  expect(f.s1MessagesAfterSecond).toBe(1)
  expect(f.s1NextSeqUnchanged).toBe(true)
  // Third firing while the second session is running.
  expect(f.sessionCountAfterThird).toBe(3)
  expect(f.distinctSessionIds).toBe(3)
  expect(f.s2StatusAfterThird).toBe('running')
  expect(f.s2MessagesAfterThird).toBe(1)
  expect(f.s1MessagesAfterThird).toBe(1)
  expect(f.runCount).toBe(3)
  expect(f.runSessionIdsAllSet).toBe(true)
  expect(f.runSessionIdsDistinct).toBe(3)
  expect(f.runStatuses).toEqual(['dispatched', 'dispatched', 'dispatched'])
})

// --- 3. paused ----------------------------------------------------------------------

dbTest('pausing clears next_run_at', () => {
  const f = fact('paused')
  expect(f.pausePaused).toBe(true)
  expect(f.pauseNextRunAt).toBeNull()
  expect(f.createdPausedPaused).toBe(true)
  expect(f.createdPausedNextRunAt).toBeNull()
})

dbTest('a paused automation is never claimed, even with next_run_at forced into the past', () => {
  const f = fact('paused')
  expect(f.sweepWhilePaused.claimed).toBe(0)
  expect(f.runsWhilePaused).toBe(0)
  expect(f.sessionsWhilePaused).toBe(0)
  expect(f.forcedNextRunAtUntouched).toBe(true)
  expect(f.secondSweepWhilePaused.claimed).toBe(0)
  expect(f.runsAfterSecondSweep).toBe(0)
})

dbTest('GET and PATCH still work on a paused automation', () => {
  const f = fact('paused')
  expect(f.getStatus).toBe(200)
  expect(f.patchStatus).toBe(200)
  expect(f.patchName).toBe('Renamed while paused')
  expect(f.patchPaused).toBe(true)
  expect(f.patchNextRunAt).toBeNull()
})

dbTest('resuming schedules the next occurrence after now and back-fills nothing', () => {
  const f = fact('paused')
  expect(f.resumeStatus).toBe(200)
  expect(f.resumedPaused).toBe(false)
  expect(f.expectedResumeCandidates).toContain(f.resumedNextRunAt)
  expect(f.sweepRightAfterResume.claimed).toBe(0)
  expect(f.runsAfterResume).toBe(0)
})

// --- 4. edits ---------------------------------------------------------------------

dbTest('editing name, prompt, orchestrator or budget leaves next_run_at alone', () => {
  const f = fact('edits')
  expect(f.afterFirstFire).toBe('2026-03-02T11:00:00.000Z')
  expect(f.nameNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.promptNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.orchNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.budgetNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  // Re-sending the unchanged cron+timezone pair is not a schedule change either.
  expect(f.samePairNextRunAt).toBe('2026-03-02T11:00:00.000Z')
})

dbTest('the next firing uses the edited name, prompt, orchestrator and budget', () => {
  const f = fact('edits')
  expect(f.secondTitle).toBe('New name · 2026-03-02 11:00')
  expect(f.secondMessageText).toBe('new prompt')
  expect(f.secondRunPrompt).toBe('new prompt')
  expect(f.secondOrchestrator).toBe('reviewer')
  expect(f.secondMaxBudgetUsd).toBe(3)
  // The earlier run and session keep what they fired with.
  expect(f.firstRunPromptSnapshot).toBe('old prompt')
  expect(f.firstSessionTitle).toBe('Old name · 2026-03-02 10:00')
  expect(f.firstSessionOrchestrator).toBe('coder')
})

dbTest('editing cron or timezone recomputes next_run_at from now', () => {
  const f = fact('edits')
  expect(f.cronExpected).toContain(f.cronNextRunAt)
  expect(f.tzExpected).toContain(f.tzNextRunAt)
})

// --- 5. delete -----------------------------------------------------------------------

dbTest(
  'deleting an automation stops its runs, cascades its run rows and keeps its sessions',
  () => {
    const f = fact('deleted')
    expect(f.runsBefore).toBe(2)
    expect(f.sessionsBefore).toBe(2)
    expect(f.deleteStatus).toBe(204)
    expect(f.sweepAfter.claimed).toBe(0)
    expect(f.sweepLater.claimed).toBe(0)
    expect(f.runsAfter).toBe(0)
    expect(f.sessionsAfter).toBe(2)
    expect(f.sameSessionsKept).toBe(true)
    expect(f.getAfterStatus).toBe(404)
  },
)

// --- 6. recurrence ------------------------------------------------------------------

function expectCleanSimulation(f: Record<string, unknown>) {
  expect(f.sweepThrew).toEqual([])
  expect(f.maxClaimedInOneTick).toBe(1)
}

dbTest('hourly 0 * * * * in UTC fires once per hour, on the hour', () => {
  const f = fact('hourlyUtc')
  expectCleanSimulation(f)
  expect(f.scheduledFor).toEqual([
    '2026-03-02T01:00:00.000Z',
    '2026-03-02T02:00:00.000Z',
    '2026-03-02T03:00:00.000Z',
    '2026-03-02T04:00:00.000Z',
    '2026-03-02T05:00:00.000Z',
    '2026-03-02T06:00:00.000Z',
  ])
  // A tick landing exactly on the due instant fires it then, not a tick later.
  expect(f.firedAtTick).toEqual(f.scheduledFor)
  // ...and the next one is strictly after that tick.
  expect(f.nextRunAtAfterEachFiring).toEqual([
    '2026-03-02T02:00:00.000Z',
    '2026-03-02T03:00:00.000Z',
    '2026-03-02T04:00:00.000Z',
    '2026-03-02T05:00:00.000Z',
    '2026-03-02T06:00:00.000Z',
    '2026-03-02T07:00:00.000Z',
  ])
})

dbTest(
  'every 3 hours 15 */3 * * * in America/New_York fires at local :15 of every third hour',
  () => {
    const f = fact('every3hNewYork')
    expectCleanSimulation(f)
    // EST is UTC-5 on 2 March 2026.
    expect(f.scheduledFor).toEqual([
      '2026-03-02T05:15:00.000Z',
      '2026-03-02T08:15:00.000Z',
      '2026-03-02T11:15:00.000Z',
      '2026-03-02T14:15:00.000Z',
      '2026-03-02T17:15:00.000Z',
      '2026-03-02T20:15:00.000Z',
      '2026-03-02T23:15:00.000Z',
      '2026-03-03T02:15:00.000Z',
    ])
    expect(f.titles).toEqual([
      'Three-hourly · 2026-03-02 00:15',
      'Three-hourly · 2026-03-02 03:15',
      'Three-hourly · 2026-03-02 06:15',
      'Three-hourly · 2026-03-02 09:15',
      'Three-hourly · 2026-03-02 12:15',
      'Three-hourly · 2026-03-02 15:15',
      'Three-hourly · 2026-03-02 18:15',
      'Three-hourly · 2026-03-02 21:15',
    ])
  },
)

dbTest(
  'weekdays 0 9 * * 1-5 in Europe/Berlin skips the weekend: Friday is followed by Monday',
  () => {
    const f = fact('weekdaysBerlin')
    expectCleanSimulation(f)
    // Thu 5, Fri 6, Mon 9, Tue 10 March — 09:00 CET is 08:00Z.
    expect(f.scheduledFor).toEqual([
      '2026-03-05T08:00:00.000Z',
      '2026-03-06T08:00:00.000Z',
      '2026-03-09T08:00:00.000Z',
      '2026-03-10T08:00:00.000Z',
    ])
    // Right after the Friday firing, next_run_at is already Monday.
    expect(f.nextRunAtAfterEachFiring[1]).toBe('2026-03-09T08:00:00.000Z')
    expect(f.titles).toEqual([
      'Weekday · 2026-03-05 09:00',
      'Weekday · 2026-03-06 09:00',
      'Weekday · 2026-03-09 09:00',
      'Weekday · 2026-03-10 09:00',
    ])
  },
)

dbTest(
  'weekends 0 9 * * 0,6 in America/New_York fires Sat+Sun 09:00 local, across the DST change',
  () => {
    const f = fact('weekendsNewYork')
    expectCleanSimulation(f)
    // Sat 7 Mar is EST (14:00Z); US DST starts Sun 8 Mar, so 09:00 EDT is 13:00Z.
    expect(f.scheduledFor).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-14T13:00:00.000Z',
      '2026-03-15T13:00:00.000Z',
    ])
    expect(f.titles).toEqual([
      'Weekend · 2026-03-07 09:00',
      'Weekend · 2026-03-08 09:00',
      'Weekend · 2026-03-14 09:00',
      'Weekend · 2026-03-15 09:00',
    ])
  },
)

// --- 7. catch-up -----------------------------------------------------------------------

dbTest('several missed occurrences fire exactly one run, then resume on schedule', () => {
  const f = fact('catchUp')
  expect(f.first.claimed).toBe(1)
  expect(f.runsAfterFirst).toBe(1)
  expect(f.firstScheduledFor).toBe('2026-02-27T05:00:00.000Z')
  expect(f.lastRunAtAfterFirst).toBe('2026-02-27T05:00:00.000Z')
  expect(f.nextRunAtAfterFirst).toBe('2026-03-02T11:00:00.000Z')
  expect(f.againClaimed).toBe(0)
  expect(f.laterClaimed).toBe(0)
  expect(f.runsBeforeNext).toBe(1)
  expect(f.nextClaimed).toBe(1)
  expect(f.scheduledForAfterNext).toEqual(['2026-02-27T05:00:00.000Z', '2026-03-02T11:00:00.000Z'])
  expect(f.sessions).toBe(2)
})

// --- 8. concurrency and idempotency -------------------------------------------------

dbTest(
  'three concurrent sweeps of one due automation produce exactly one run and one session',
  () => {
    const f = fact('concurrentSweeps')
    expect(f.rounds).toHaveLength(5)
    f.rounds.forEach((round: Record<string, unknown>, i: number) => {
      expect(round.rejected).toEqual([])
      expect(round.claimedTotal).toBe(1)
      expect(round.runCount).toBe(i + 1)
      expect(round.sessionCount).toBe(i + 1)
      expect(round.nextRunAt).toBe(`2026-03-02T${String(11 + i).padStart(2, '0')}:00:00.000Z`)
    })
  },
)

dbTest(
  'a stale next_run_at written back over a claim neither duplicates the run nor sticks',
  () => {
    const f = fact('lostUpdate')
    expect(f.afterFire).toBe('2026-03-02T11:00:00.000Z')
    expect(f.threw).toBe('')
    expect(f.result.claimed).toBe(0)
    expect(f.runsAfterStale).toBe(1)
    expect(f.sessionsAfterStale).toBe(1)
    expect(f.nextRunAtAfterStale).toBe('2026-03-02T11:00:00.000Z')
    expect(f.followingClaimed).toBe(1)
    expect(f.scheduledForAfterFollowing).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T11:00:00.000Z',
    ])
    expect(f.nextRunAtAfterFollowing).toBe('2026-03-02T12:00:00.000Z')
  },
)

dbTest('a name PATCH after, or racing, a claim never reverts next_run_at', () => {
  const f = fact('patchAfterClaim')
  expect(f.patchStatus).toBe(200)
  expect(f.patchNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.rowNextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.rowName).toBe('renamed after claim')
  f.races.forEach((race: Record<string, unknown>, i: number) => {
    expect(race.newRuns).toBe(1)
    expect(race.nextRunAt).toBe(`2026-03-02T${String(12 + i).padStart(2, '0')}:00:00.000Z`)
  })
})

dbTest(
  'a name PATCH whose write lands right after a claim commits does not revert next_run_at',
  () => {
    const f = fact('patchRacesClaim')
    expect(f.sweepClaimed).toBe(1)
    expect(f.patchName).toBe('renamed mid-claim')
    expect(f.rowName).toBe('renamed mid-claim')
    expect(f.runs).toEqual(['2026-03-02T11:00:00.000Z'])
    expect(f.lastRunAt).toBe('2026-03-02T11:00:00.000Z')
    expect(f.rowNextRunAt).toBe('2026-03-02T12:00:00.000Z')
    expect(f.followUpClaimed).toBe(0)
  },
)

// --- 9. failure paths --------------------------------------------------------------

dbTest('a project that is not ready fails the run readably and still advances the schedule', () => {
  const f = fact('dispatchFailures')
  expect(f.threw).toBe('')
  expect(f.notReady.runCount).toBe(1)
  expect(f.notReady.status).toBe('failed')
  expect(f.notReady.error).toContain('Could not create a session')
  expect(f.notReady.error).toContain('cloning')
  expect(f.notReady.sessionId).toBeNull()
  expect(f.notReady.sessions).toBe(0)
  expect(f.notReady.nextRunAt).toBe('2026-03-02T11:00:00.000Z')
  expect(f.notReady.lastRunAt).toBe('2026-03-02T10:00:00.000Z')
})

dbTest(
  'a base branch that does not exist fails the run readably and still advances the schedule',
  () => {
    const f = fact('dispatchFailures')
    expect(f.badBranch.runCount).toBe(1)
    expect(f.badBranch.status).toBe('failed')
    expect(f.badBranch.error).toContain('no-such-branch')
    expect(f.badBranch.sessions).toBe(0)
    expect(f.badBranch.nextRunAt).toBe('2026-03-02T11:00:00.000Z')
  },
)

dbTest(
  'failing automations do not stop a healthy one in the same sweep, and are not retried',
  () => {
    const f = fact('dispatchFailures')
    expect(f.result).toEqual({ claimed: 3, dispatched: 1, failed: 2, staleRecovered: 0 })
    expect(f.healthy.status).toBe('dispatched')
    expect(f.healthy.sessions).toBe(1)
    expect(f.retryClaimed).toBe(0)
    expect(f.notReadyRunsAfterRetry).toBe(1)
  },
)

dbTest(
  'a run stuck dispatching for over 10 minutes is failed, and nothing is re-dispatched',
  () => {
    const f = fact('staleDispatching')
    expect(f.first.staleRecovered).toBe(1)
    expect(f.first.claimed).toBe(0)
    expect(f.oldStatus).toBe('failed')
    expect(f.oldError).toContain('Stranded')
    expect(f.oldSessionId).toBeNull()
    // 9 minutes old is not stale yet; 29 minutes old is.
    expect(f.recentStatusAfterFirst).toBe('dispatching')
    expect(f.second.staleRecovered).toBe(1)
    expect(f.recentStatusAfterSecond).toBe('failed')
    expect(f.third.staleRecovered).toBe(0)
    expect(f.sessions).toBe(0)
    expect(f.runCount).toBe(2)
  },
)

dbTest(
  'a hand-corrupted cron or timezone is disabled without crashing the sweep or looping',
  () => {
    const f = fact('corruptSchedule')
    expect(f.threw).toBe('')
    // Only the healthy one fired.
    expect(f.result.claimed).toBe(1)
    expect(f.badCronNextRunAt).toBeNull()
    expect(f.badCronRuns).toBe(0)
    expect(f.badTzNextRunAt).toBeNull()
    expect(f.badTzRuns).toBe(0)
    expect(f.secondClaimed).toBe(0)
    // Days later only the healthy one is due again.
    expect(f.thirdClaimedOnlyGood).toBe(1)
    expect(f.goodRuns.map((r: { status: string }) => r.status)).toEqual([
      'dispatched',
      'dispatched',
    ])
    expect(f.getCorruptStatus).toBe(200)
  },
)

// --- the worker side ---------------------------------------------------------------

dbTest('the sweep worker runs sweepAutomations on its job, on a 15 second schedule', () => {
  const f = fact('workerWiring')
  expect(f.queueName).toBe('automation-sweep')
  expect(f.processorRegistered).toBe(true)
  expect(f.processorResult.claimed).toBe(1)
  expect(f.runCount).toBe(1)
  expect(f.runStatus).toBe('dispatched')
  expect(f.schedulerRepeat).toEqual([{ every: 15_000 }])
})
