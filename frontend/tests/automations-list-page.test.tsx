// The project's Automations list page (/projects/<pid>/automations), mounted
// through the real router and shell with every automations client replaced
// by tests/automations-harness.tsx's stateful fake server.
//
// What it pins down:
//   - each row shows the name (a link to the detail route), a human schedule
//     summary, the next run or "Paused", and the run count;
//   - with no automations there is an empty state, not an empty table;
//   - the Active switch sends PATCH { paused } with the right polarity;
//   - Delete from the row menu asks first, sends nothing until confirmed,
//     then sends DELETE and the row disappears.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  automation,
  buttonByText,
  captureConsoleErrors,
  click,
  installAutomationsServer,
  type Mounted,
  mountAt,
  text,
} from './automations-harness'

const server = await installAutomationsServer()
const { routeTree } = await import('../src/app/router')

const problems = captureConsoleErrors()
let m: Mounted

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  server.reset()
})
afterEach(async () => {
  await m?.unmount()
})

const main = () => m.container.querySelector('main') as HTMLElement
const headers = () => [...main().querySelectorAll('thead th')].map(text)
/** Every body row as { header text → cell }. */
const rows = () =>
  [...main().querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.querySelectorAll('td')]
    return Object.fromEntries(headers().map((h, i) => [h, cells[i] as HTMLElement]))
  })
const rowFor = (name: string) => {
  const found = rows().find((r) => text(r.Name) === name)
  if (!found) throw new Error(`no row for ${name}`)
  return found
}

test('each row: name linking to its detail page, schedule summary, next run, run count', async () => {
  const next = '2026-10-06T09:00:00.000Z'
  server.automations = [
    automation({ id: 'a1', name: 'Morning', cron: '30 7 * * 1-5', nextRunAt: next, runCount: 4 }),
    automation({ id: 'a2', name: 'Hourly', cron: '15 */3 * * *', runCount: 0 }),
    automation({ id: 'a3', name: 'Odd', cron: '0 9 1 * *', runCount: 12 }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations')

  expect(rows()).toHaveLength(3)
  const morning = rowFor('Morning')
  const link = morning.Name?.querySelector('a')
  expect(link?.getAttribute('href')).toBe('/projects/p1/automations/a1')
  expect(text(morning.Schedule)).toBe('Weekdays at 07:30')
  // The fixture's zone is UTC: the automation's zone, shown as such.
  expect(text(morning['Next run'])).toBe('Oct 6, 2026, 9:00 AM')
  expect(text(morning.Runs)).toBe('4')

  expect(rowFor('Hourly').Name?.querySelector('a')?.getAttribute('href')).toBe(
    '/projects/p1/automations/a2',
  )
  expect(text(rowFor('Hourly').Schedule)).toBe('Every 3 hours at :15')
  expect(text(rowFor('Hourly').Runs)).toBe('0')
  expect(text(rowFor('Odd').Schedule)).toBe('Custom: 0 9 1 * *')
  expect(text(rowFor('Odd').Runs)).toBe('12')
  expect(problems).toEqual([])
})

// The runner's own zone is UTC, so only a non-UTC automation can tell "the
// automation's zone" apart from "browser-local". Expected strings are written
// by hand (en-US, the runner's default locale), not computed by the formatter
// under test.
test("Next run and Last run are shown in each automation's own zone, not the browser's", async () => {
  server.automations = [
    automation({
      id: 'a1',
      name: 'Berlin',
      timezone: 'Europe/Berlin',
      cron: '30 9 * * *',
      // Either side of the 25 Oct 2026 DST change: 09:30 CEST (UTC+2) last
      // time, 09:30 CET (UTC+1) next time — the same wall time as the schedule.
      lastRunAt: '2026-10-24T07:30:00.000Z',
      nextRunAt: '2026-10-26T08:30:00.000Z',
      runCount: 3,
    }),
    automation({
      id: 'a2',
      name: 'Tokyo',
      timezone: 'Asia/Tokyo',
      // UTC evenings, which are the next morning in Tokyo (UTC+9).
      lastRunAt: '2026-10-05T20:30:00.000Z',
      nextRunAt: '2026-10-06T20:30:00.000Z',
      runCount: 1,
    }),
    automation({
      id: 'a3',
      name: 'Fresh',
      timezone: 'Asia/Tokyo',
      lastRunAt: null,
      nextRunAt: '2026-10-06T09:00:00.000Z',
    }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations')

  expect(text(rowFor('Berlin')['Next run'])).toBe('Oct 26, 2026, 9:30 AM')
  expect(text(rowFor('Berlin')['Last run'])).toBe('Oct 24, 2026, 9:30 AM')
  expect(text(rowFor('Tokyo')['Next run'])).toBe('Oct 7, 2026, 5:30 AM')
  expect(text(rowFor('Tokyo')['Last run'])).toBe('Oct 6, 2026, 5:30 AM')
  expect(text(rowFor('Fresh')['Next run'])).toBe('Oct 6, 2026, 6:00 PM')
  expect(text(rowFor('Fresh')['Last run'])).toBe('Never')
  expect(problems).toEqual([])
})

test('a paused automation reads "Paused" in place of its next run, and its switch is off', async () => {
  server.automations = [
    automation({ id: 'a1', name: 'Sleeper', paused: true, nextRunAt: '2026-10-06T09:00:00.000Z' }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations')
  const row = rowFor('Sleeper')
  expect(text(row['Next run'])).toBe('Paused')
  const sw = row.Active?.querySelector('[role="switch"]')
  expect(sw?.getAttribute('aria-checked')).toBe('false')
  expect(sw?.getAttribute('aria-label')).toBe('Resume "Sleeper"')
})

test('no automations: an empty state, and no table', async () => {
  m = await mountAt(routeTree, '/projects/p1/automations')
  expect(text(main())).toContain('No automations yet.')
  expect(main().querySelector('table')).toBeNull()
  expect(server.calls.list).toEqual(['p1'])
})

test("only this project's automations are listed", async () => {
  server.automations = [
    automation({ id: 'a1', name: 'Mine' }),
    automation({ id: 'a9', projectId: 'p2', name: 'Theirs' }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations')
  expect(rows().map((r) => text(r.Name))).toEqual(['Mine'])
})

test('turning the Active switch off sends PATCH { paused: true }, and the row then reads Paused', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning', paused: false })]
  m = await mountAt(routeTree, '/projects/p1/automations')
  const sw = rowFor('Morning').Active?.querySelector('[role="switch"]')
  expect(sw?.getAttribute('aria-checked')).toBe('true')

  await click(sw, 'active switch')

  expect(server.calls.patch).toEqual([{ id: 'a1', body: { paused: true } }])
  expect(text(rowFor('Morning')['Next run'])).toBe('Paused')
  expect(
    rowFor('Morning').Active?.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
  ).toBe('false')
})

test("turning a paused automation's switch on sends PATCH { paused: false }", async () => {
  server.automations = [automation({ id: 'a1', name: 'Sleeper', paused: true })]
  m = await mountAt(routeTree, '/projects/p1/automations')
  await click(rowFor('Sleeper').Active?.querySelector('[role="switch"]'), 'active switch')
  expect(server.calls.patch).toEqual([{ id: 'a1', body: { paused: false } }])
})

test('Delete asks for confirmation first, then sends DELETE and the row goes away', async () => {
  server.automations = [
    automation({ id: 'a1', name: 'Morning' }),
    automation({ id: 'a2', name: 'Evening' }),
  ]
  m = await mountAt(routeTree, '/projects/p1/automations')

  const menuButton = main().querySelector('button[aria-label=\'Actions for "Morning"\']')
  await click(menuButton, 'row actions trigger')
  const deleteItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(
    (el) => text(el) === 'Delete',
  )
  await click(deleteItem, 'Delete menu item')

  // Asked, not done.
  const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement | null
  expect(dialog).not.toBeNull()
  expect(text(dialog)).toContain('Delete "Morning"?')
  expect(server.calls.delete).toEqual([])

  await click(buttonByText(dialog as HTMLElement, 'Delete'), 'confirm Delete')

  expect(server.calls.delete).toEqual(['a1'])
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  expect(rows().map((r) => text(r.Name))).toEqual(['Evening'])
})

test('cancelling the delete confirmation sends nothing', async () => {
  server.automations = [automation({ id: 'a1', name: 'Morning' })]
  m = await mountAt(routeTree, '/projects/p1/automations')
  await click(main().querySelector('button[aria-label=\'Actions for "Morning"\']'), 'menu')
  await click(
    [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => text(el) === 'Delete'),
    'Delete menu item',
  )
  const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement
  await click(buttonByText(dialog, 'Cancel'), 'Cancel')
  expect(server.calls.delete).toEqual([])
  expect(rows().map((r) => text(r.Name))).toEqual(['Morning'])
})
