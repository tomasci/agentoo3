// One automation's own page (/projects/<pid>/automations/<aid>), mounted
// through the real router and shell against tests/automations-harness.tsx's
// fake server.
//
// Header: name, Active/Paused, schedule summary, timezone, next run, prompt.
// Actions: Pause/Resume is PATCH { paused }; Delete confirms, sends DELETE,
// then returns to the list. Run history: rendered in the API's newest-first
// order, one shape per run state. Polling: both the automation and its runs
// refetch on a 15s interval — fired here on demand by capturing exactly the
// 15_000ms `setInterval`s react-query's timeoutManager schedules (the same
// approach tests/editor-running-editors.test.tsx takes for its own poll).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  automation,
  buttonByText,
  captureConsoleErrors,
  click,
  control,
  installAutomationsServer,
  type Mounted,
  mountAt,
  run,
  settle,
  text,
  typeInto,
} from './automations-harness'

const server = await installAutomationsServer()
const { routeTree } = await import('../src/app/router')
const { zoneWithOffset } = await import('../src/shared/lib/timezones')

// ── the poll timer ──────────────────────────────────────────────────────────

const POLL_MS = 15_000
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let polls: { id: number; cb: () => void }[] = []
let nextPollId = 2_000_000
globalThis.setInterval = ((cb: () => void, delay?: number, ...rest: unknown[]) => {
  if (delay === POLL_MS) {
    const id = nextPollId++
    polls.push({ id, cb })
    return id as unknown as ReturnType<typeof setInterval>
  }
  return realSetInterval(cb, delay, ...rest)
}) as typeof setInterval
globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
  const i = polls.findIndex((p) => p.id === (id as unknown as number))
  if (i !== -1) {
    polls.splice(i, 1)
    return
  }
  realClearInterval(id as Parameters<typeof clearInterval>[0])
}) as typeof clearInterval
afterAll(() => {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})
/** As if 15s had passed: runs every scheduled 15s interval once. */
const firePolls = async () => {
  const due = [...polls]
  await act(async () => {
    for (const p of due) p.cb()
  })
  await settle()
}

const problems = captureConsoleErrors()
let m: Mounted

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  polls = []
  server.reset()
})
afterEach(async () => {
  await m?.unmount()
})

const main = () => m.container.querySelector('main') as HTMLElement
const runItems = () => {
  const heading = [...main().querySelectorAll('h2')].find((h) => text(h) === 'Run history')
  const card = heading?.closest('[data-slot="card"]')
  return [...(card?.querySelectorAll('ul > li') ?? [])] as HTMLElement[]
}
const runsCard = () =>
  [...main().querySelectorAll('h2')]
    .find((h) => text(h) === 'Run history')
    ?.closest('[data-slot="card"]') as HTMLElement

const NEXT = '2026-10-06T09:00:00.000Z'

// Every instant on this page is shown in the *automation's own* zone, not the
// browser's, so it agrees with the schedule summary beside it. Expected
// strings are written out by hand (en-US, the runner's default locale) rather
// than computed by the formatter under test. The runner's own zone is UTC, so
// only a non-UTC automation can tell "the automation's zone" apart from
// "browser-local": those cases use Europe/Berlin (UTC+2 until 25 Oct 2026)
// and Asia/Tokyo (UTC+9, which moves an evening UTC instant to the next day).

// ── header ──────────────────────────────────────────────────────────────────

test('shows the name, Active, schedule summary, timezone, next run and the prompt', async () => {
  server.automations = [
    automation({
      id: 'a1',
      name: 'Morning digest',
      cron: '30 7 * * 1-5',
      timezone: 'Europe/Berlin',
      nextRunAt: NEXT,
      prompt: 'Summarise **overnight** activity',
    }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  const body = text(main())
  expect(text(main().querySelector('h1'))).toBe('Morning digest')
  expect(body).toContain('Active')
  expect(body).toContain('Weekdays at 07:30')
  expect(body).toContain(zoneWithOffset('Europe/Berlin'))
  // 09:00Z is 11:00 in Berlin (CEST) — not the runner-local 9:00 AM.
  expect(body).toContain('Next run: Oct 6, 2026, 11:00 AM')
  expect(body).not.toContain('9:00 AM')
  expect(body).toContain('Summarise overnight activity')
  // The prompt is rendered as Markdown, not raw text.
  expect(main().querySelector('strong')?.textContent).toBe('overnight')
  expect(buttonByText(main(), 'Pause')).toBeDefined()
  expect(problems).toEqual([])
})

test('a paused automation reads Paused, its next run reads Paused, and offers Resume', async () => {
  server.automations = [automation({ id: 'a1', paused: true, nextRunAt: NEXT })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  const body = text(main())
  expect(body).toContain('Next run: Paused')
  expect(body).not.toContain('Oct 6, 2026, 9:00 AM')
  expect(buttonByText(main(), 'Resume')).toBeDefined()
  expect([...main().querySelectorAll('button')].map(text)).not.toContain('Pause')
})

test("an unknown automation id shows the server's not-found message", async () => {
  m = await mountAt(routeTree, '/projects/p1/automations/missing')
  expect(text(main())).toContain('Automation not found')
})

// ── pause / resume / delete ─────────────────────────────────────────────────

test('Pause sends PATCH { paused: true }, after which the page reads Paused and offers Resume', async () => {
  server.automations = [automation({ id: 'a1', paused: false })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Pause'), 'Pause')
  expect(server.calls.patch).toEqual([{ id: 'a1', body: { paused: true } }])
  expect(text(main())).toContain('Next run: Paused')
  await click(buttonByText(main(), 'Resume'), 'Resume')
  expect(server.calls.patch).toEqual([
    { id: 'a1', body: { paused: true } },
    { id: 'a1', body: { paused: false } },
  ])
})

test('Delete confirms first, then sends DELETE and navigates back to the list', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning' })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Delete'), 'Delete')

  const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement | null
  expect(dialog).not.toBeNull()
  expect(text(dialog)).toContain('Delete "Morning"?')
  expect(server.calls.delete).toEqual([])
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations/a1')

  await click(buttonByText(dialog as HTMLElement, 'Delete'), 'confirm Delete')
  await settle()

  expect(server.calls.delete).toEqual(['a1'])
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations')
  expect(text(main().querySelector('h1'))).toBe('Automations')
  expect(text(main())).toContain('No automations yet.')
})

test('cancelling Delete sends nothing and stays on the page', async () => {
  server.automations = [automation({ id: 'a1' })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Delete'), 'Delete')
  const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement
  await click(buttonByText(dialog, 'Cancel'), 'Cancel')
  expect(server.calls.delete).toEqual([])
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations/a1')
})

// ── run history ─────────────────────────────────────────────────────────────

test('run history: newest first, one shape per run state', async () => {
  server.automations = [automation({ id: 'a1' })]
  // The API's own order is newest first (backend orders by scheduledFor desc).
  server.runs.a1 = [
    run({ id: 'r4', status: 'dispatching', scheduledFor: '2026-10-04T09:00:00.000Z' }),
    run({
      id: 'r3',
      status: 'dispatched',
      sessionId: 's3',
      scheduledFor: '2026-10-03T09:00:00.000Z',
      session: {
        id: 's3',
        title: 'Deps check Oct 3',
        status: 'running',
        totalCostUsd: 0.25,
        unchecked: true,
      },
    }),
    run({
      id: 'r2',
      status: 'failed',
      error: 'Project is not ready',
      scheduledFor: '2026-10-02T09:00:00.000Z',
    }),
    run({
      id: 'r1',
      status: 'dispatched',
      sessionId: null,
      session: null,
      scheduledFor: '2026-10-01T09:00:00.000Z',
    }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')

  const items = runItems()
  expect(items).toHaveLength(4)
  // Newest first: each item's "Fired" time, in render order.
  const fired = [
    'Oct 4, 2026, 9:00 AM',
    'Oct 3, 2026, 9:00 AM',
    'Oct 2, 2026, 9:00 AM',
    'Oct 1, 2026, 9:00 AM',
  ]
  items.forEach((li, i) => {
    expect(text(li)).toContain(`Fired: ${fired[i]}`)
  })

  const [dispatching, dispatched, failed, orphan] = items as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ]

  expect(text(dispatching)).toContain('Starting')
  expect(dispatching.querySelector('a')).toBeNull()
  expect(text(dispatching)).not.toContain('Session deleted')

  const link = dispatched.querySelector('a')
  expect(link?.getAttribute('href')).toBe('/projects/p1/sessions/s3')
  expect(text(dispatched)).toContain('Started')
  expect(text(link)).toContain('Deps check Oct 3')
  expect(text(link)).toContain('Running')
  expect(text(link)).toContain('$0.2500')
  expect(text(link)).toContain('Unchecked')

  expect(text(failed)).toContain('Failed')
  expect(text(failed)).toContain('Project is not ready')
  expect(failed.querySelector('[role="alert"]')).not.toBeNull()
  expect(failed.querySelector('a')).toBeNull()

  expect(text(orphan)).toContain('Started')
  expect(text(orphan)).toContain('Session deleted')
  expect(orphan.querySelector('a')).toBeNull()
  expect(problems).toEqual([])
})

test('a dispatched run whose session has no title falls back to "Untitled"-style text with the id', async () => {
  server.automations = [automation({ id: 'a1' })]
  server.runs.a1 = [
    run({
      id: 'r1',
      status: 'dispatched',
      sessionId: 'abcdef1234567890',
      session: {
        id: 'abcdef1234567890',
        title: null,
        status: 'completed',
        totalCostUsd: 0,
        unchecked: false,
      },
    }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  const link = runItems()[0]?.querySelector('a')
  expect(link?.getAttribute('href')).toBe('/projects/p1/sessions/abcdef1234567890')
  expect(text(link)).toContain('abcdef12')
  expect(text(link)).toContain('Completed')
  expect(text(link)).not.toContain('Unchecked')
})

test('no runs: an empty state naming the next run', async () => {
  server.automations = [automation({ id: 'a1', nextRunAt: NEXT })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(runItems()).toHaveLength(0)
  expect(text(runsCard())).toContain('No runs yet — next run Oct 6, 2026, 9:00 AM.')
})

test('no runs on a paused automation: the plain empty state', async () => {
  server.automations = [automation({ id: 'a1', paused: true, nextRunAt: NEXT })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(text(runsCard())).toContain('No runs yet.')
  expect(text(runsCard())).not.toContain('next run')
})

// ── times in the automation's own zone ──────────────────────────────────────

test("no runs, non-UTC automation: the empty state's next run is in the automation's zone", async () => {
  server.automations = [
    automation({ id: 'a1', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-06T20:30:00.000Z' }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(runItems()).toHaveLength(0)
  // 20:30Z on Oct 6 is 05:30 on Oct 7 in Tokyo — date and time both move.
  expect(text(runsCard())).toContain('No runs yet — next run Oct 7, 2026, 5:30 AM.')
  expect(text(runsCard())).not.toContain('Oct 6, 2026')
})

test("header next run, non-UTC automation across a date line: shown in the automation's zone", async () => {
  server.automations = [
    automation({ id: 'a1', timezone: 'Asia/Tokyo', nextRunAt: '2026-10-06T20:30:00.000Z' }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(text(main())).toContain('Next run: Oct 7, 2026, 5:30 AM')
  expect(text(main())).not.toContain('8:30 PM')
})

test("run history, non-UTC automation: Fired and Started are in the automation's zone", async () => {
  server.automations = [automation({ id: 'a1', timezone: 'Asia/Tokyo' })]
  server.runs.a1 = [
    run({
      id: 'r2',
      status: 'dispatched',
      sessionId: 's2',
      scheduledFor: '2026-10-05T22:00:00.000Z',
      startedAt: '2026-10-05T22:01:00.000Z',
      session: { id: 's2', title: 'Night', status: 'completed', totalCostUsd: 0, unchecked: false },
    }),
    run({
      id: 'r1',
      status: 'failed',
      error: 'Project is not ready',
      scheduledFor: '2026-10-04T09:00:00.000Z',
      startedAt: '2026-10-04T09:00:30.000Z',
    }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  const [night, day] = runItems() as [HTMLElement, HTMLElement]
  // 22:00Z / 22:01Z on Oct 5 are 07:00 / 07:01 on Oct 6 in Tokyo.
  expect(text(night)).toContain('Fired: Oct 6, 2026, 7:00 AM')
  expect(text(night)).toContain('Started: Oct 6, 2026, 7:01 AM')
  expect(text(night)).not.toContain('Oct 5, 2026')
  // 09:00Z / 09:00:30Z on Oct 4 are 18:00 in Tokyo (minute precision).
  expect(text(day)).toContain('Fired: Oct 4, 2026, 6:00 PM')
  expect(text(day)).toContain('Started: Oct 4, 2026, 6:00 PM')
  expect(text(day)).not.toContain('9:00 AM')
  expect(problems).toEqual([])
})

// ── polling ─────────────────────────────────────────────────────────────────

test('the automation and its runs refetch every 15s while the page is open', async () => {
  server.automations = [automation({ id: 'a1', runCount: 0, nextRunAt: NEXT })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(server.calls.get).toEqual(['a1'])
  expect(server.calls.runs).toEqual(['a1'])
  expect(runItems()).toHaveLength(0)

  // A firing happens on the server between polls.
  const later = '2026-10-07T09:00:00.000Z'
  server.automations = [automation({ id: 'a1', runCount: 1, nextRunAt: later, lastRunAt: NEXT })]
  server.runs.a1 = [run({ id: 'r1', status: 'dispatching', scheduledFor: NEXT })]

  await firePolls()

  expect(server.calls.get).toEqual(['a1', 'a1'])
  expect(server.calls.runs).toEqual(['a1', 'a1'])
  expect(runItems()).toHaveLength(1)
  expect(text(main())).toContain('Next run: Oct 7, 2026, 9:00 AM')
})

test('the 15s interval is on the automation and runs queries themselves', async () => {
  server.automations = [automation({ id: 'a1' })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  const intervalsFor = (url: string) =>
    m.client
      .getQueryCache()
      .findAll()
      .filter((q) => (q.queryKey[0] as { url?: string })?.url === url)
      .flatMap((q) => q.observers.map((o) => o.options.refetchInterval))
  expect(intervalsFor('/api/automations/:id')).toEqual([POLL_MS])
  expect(intervalsFor('/api/automations/:id/runs')).toEqual([POLL_MS])
  // The list's own query does not poll.
  await act(async () => {
    await m.router.navigate({ to: '/projects/$projectId/automations', params: { projectId: 'p1' } })
  })
  await settle()
  expect(intervalsFor('/api/projects/:id/automations')).toEqual([undefined])
})

test('leaving the detail page stops its two polls', async () => {
  server.automations = [automation({ id: 'a1' })]
  m = await mountAt(routeTree, '/projects/p1/automations')
  // Whatever the shell itself polls at 15s (health, notifications).
  const shellPolls = polls.length
  await act(async () => {
    await m.router.navigate({
      to: '/projects/$projectId/automations/$automationId',
      params: { projectId: 'p1', automationId: 'a1' },
    })
  })
  await settle()
  expect(polls.length).toBe(shellPolls + 2)
  await act(async () => {
    await m.router.navigate({ to: '/projects/$projectId/automations', params: { projectId: 'p1' } })
  })
  await settle()
  expect(polls.length).toBe(shellPolls)
  const getsBefore = server.calls.get.length
  await firePolls()
  expect(server.calls.get.length).toBe(getsBefore)
})

// ── edit from the detail page ───────────────────────────────────────────────

const editDialog = () =>
  document
    .getElementById('automation-form')
    ?.closest('[data-slot="dialog-content"]') as HTMLElement | null

test('Edit on the detail page opens the dialog pre-filled and saves a PATCH', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning', cron: '0 9 * * *' })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Edit'), 'Edit')
  const dialog = editDialog() as HTMLElement
  expect((control(dialog, 'Name') as HTMLInputElement).value).toBe('Morning')
  await typeInto(control(dialog, 'Name'), 'Renamed')
  await click(buttonByText(dialog, 'Save'), 'Save')
  expect(server.calls.patch).toHaveLength(1)
  expect(server.calls.patch[0]?.body).toMatchObject({ name: 'Renamed', cron: '0 9 * * *' })
  expect(text(main().querySelector('h1'))).toBe('Renamed')
})

test('a background poll that changes the automation does not wipe edits in an open Edit dialog', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning', runCount: 0, nextRunAt: NEXT })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Edit'), 'Edit')
  await typeInto(control(editDialog() as HTMLElement, 'Name'), 'Half-typed new name')

  // The automation fires on the server while the reader is typing: only the
  // server-owned counters move.
  server.automations = [
    automation({
      id: 'a1',
      name: 'Morning',
      runCount: 1,
      lastRunAt: NEXT,
      nextRunAt: '2026-10-07T09:00:00.000Z',
    }),
  ]
  await firePolls()

  expect(editDialog()).not.toBeNull()
  expect((control(editDialog() as HTMLElement, 'Name') as HTMLInputElement).value).toBe(
    'Half-typed new name',
  )
})

// The control for the case above: a poll whose answer is structurally
// unchanged keeps the same `automation` object (react-query's structural
// sharing), so the dialog is left alone — which isolates the failure above to
// "the polled automation changed", not "a poll happened".
test('a background poll that changes nothing leaves an open Edit dialog alone', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning' })]
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  await click(buttonByText(main(), 'Edit'), 'Edit')
  await typeInto(control(editDialog() as HTMLElement, 'Name'), 'Half-typed new name')
  await firePolls()
  expect(server.calls.get.length).toBe(2)
  expect((control(editDialog() as HTMLElement, 'Name') as HTMLInputElement).value).toBe(
    'Half-typed new name',
  )
})
