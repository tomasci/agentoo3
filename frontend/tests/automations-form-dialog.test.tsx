// The automation create/edit dialog, opened from the real list page through
// the real router, against tests/automations-harness.tsx's fake server.
//
// Create: every schedule preset puts the canonical cron into the POST body;
// the timezone defaults to the browser's own zone (UTC when that zone is not
// offered); orchestrator is required; the live preview is debounced; an
// invalid preview shows its error and disables Save; a server 400 is shown.
//
// Edit: the dialog re-opens an automation's cron in the preset it came from
// (a non-canonical cron in Custom, raw text intact), and Save sends a PATCH.
//
// The preview debounce (schedule-fields.tsx, 400ms) is driven by capturing
// exactly those 400ms `setTimeout`s and firing them on demand — the same
// patch-the-global-timer approach tests/editor-running-editors.test.tsx uses
// for its poll — so "debounced" is checked by counting, not by racing a
// real clock.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  automation,
  buttonByText,
  captureConsoleErrors,
  choose,
  click,
  control,
  installAutomationsServer,
  type Mounted,
  mountAt,
  settle,
  text,
  typeInto,
} from './automations-harness'

const server = await installAutomationsServer()
const { routeTree } = await import('../src/app/router')

// ── the debounce timer ──────────────────────────────────────────────────────

const DEBOUNCE_MS = 400
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let pendingDebounces: { id: number; cb: () => void }[] = []
let nextId = 1_000_000
globalThis.setTimeout = ((cb: () => void, delay?: number, ...rest: unknown[]) => {
  if (delay === DEBOUNCE_MS) {
    const id = nextId++
    pendingDebounces.push({ id, cb })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  return realSetTimeout(cb, delay, ...rest)
}) as typeof setTimeout
globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
  const i = pendingDebounces.findIndex((p) => p.id === (id as unknown as number))
  if (i !== -1) {
    pendingDebounces.splice(i, 1)
    return
  }
  realClearTimeout(id as Parameters<typeof clearTimeout>[0])
}) as typeof clearTimeout
afterAll(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

/** As if 400ms of quiet had passed: fires every pending debounce. */
const flushPreview = async () => {
  const due = pendingDebounces.splice(0)
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
  pendingDebounces = []
  server.reset()
})
afterEach(async () => {
  await m?.unmount()
})

// ── dialog helpers ──────────────────────────────────────────────────────────

const dialog = () => {
  const form = document.getElementById('automation-form')
  return (form?.closest('[data-slot="dialog-content"]') ?? null) as HTMLElement | null
}
const d = () => {
  const found = dialog()
  if (!found) throw new Error('dialog not open')
  return found
}
/** What a Select trigger currently shows — its `SelectValue` slot, without
 *  the chevron icon the trigger also renders. */
const shown = (trigger: HTMLElement) => text(trigger.querySelector('[data-slot="select-value"]'))
/** The day checkboxes that are ticked, by their visible label. */
const tickedDays = () =>
  [...d().querySelectorAll('[role="checkbox"]')]
    .filter((box) => box.getAttribute('aria-checked') === 'true')
    .map((box) => text(box.closest('[data-slot="field"]')?.querySelector('label')))
const saveButton = () => buttonByText(d(), 'Save')
const kindTrigger = () => control(d(), 'Schedule')
const timeInput = () => control(d(), 'Time') as HTMLInputElement

async function openCreate() {
  m = await mountAt(routeTree, '/projects/p1/automations')
  await click(buttonByText(m.container, 'New automation'), 'New automation')
  expect(text(d().querySelector('[data-slot="dialog-title"]'))).toBe('New automation')
}

async function fillBasics(name = 'Job', prompt = 'Do the thing') {
  await typeInto(control(d(), 'Name'), name)
  await typeInto(control(d(), 'Prompt'), prompt)
  await choose(control(d(), 'Orchestrator'), optionLead())
}
/** The orchestrator option renders the name and its description in one
 *  option, so its full text is "lead" + "lead description". */
const optionLead = () => 'leadlead description'

async function save() {
  await click(saveButton(), 'Save')
}

const createdCron = () => {
  expect(server.calls.create).toHaveLength(1)
  return server.calls.create[0]?.body.cron
}

// ── 3. presets → cron in the POST body ──────────────────────────────────────

test('default preset: every day at 09:00 → "0 9 * * *", with the full body', async () => {
  await openCreate()
  expect(shown(kindTrigger())).toBe('Every day')
  expect(timeInput().value).toBe('09:00')
  await fillBasics('Nightly', 'Check deps')
  await save()

  expect(server.calls.create).toEqual([
    {
      projectId: 'p1',
      body: {
        name: 'Nightly',
        prompt: 'Check deps',
        cron: '0 9 * * *',
        timezone: expect.any(String),
        orchestrator: 'lead',
      },
    },
  ])
  expect(dialog()).toBeNull()
  expect(problems).toEqual([])
})

test('weekdays at 07:30 → "30 7 * * 1-5"', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Weekdays (Mon–Fri)')
  await typeInto(timeInput(), '07:30')
  await save()
  expect(createdCron()).toBe('30 7 * * 1-5')
})

test('weekends at 10:05 → "5 10 * * 0,6"', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Weekends (Sat, Sun)')
  await typeInto(timeInput(), '10:05')
  await save()
  expect(createdCron()).toBe('5 10 * * 0,6')
})

test('specific days Mon/Wed/Fri at 08:00, ticked out of order → "0 8 * * 1,3,5"', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Specific days')
  await typeInto(timeInput(), '08:00')
  for (const day of [5, 1, 3])
    await click(d().querySelector(`#automation-day-${day}`), `day ${day}`)
  await save()
  expect(createdCron()).toBe('0 8 * * 1,3,5')
})

test('specific days with none ticked is refused inline, nothing sent', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Specific days')
  await save()
  expect(server.calls.create).toEqual([])
  expect(text(d())).toContain('Choose at least one day')
})

test('every 3 hours at :15 → "15 */3 * * *"', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Every N hours')
  await choose(control(d(), 'Every N hours'), '3')
  await typeInto(control(d(), 'Minute'), '15')
  await save()
  expect(createdCron()).toBe('15 */3 * * *')
})

test('every 1 hour (the default step) at :00 → "0 * * * *"', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Every N hours')
  expect(shown(control(d(), 'Every N hours'))).toBe('1')
  await save()
  expect(createdCron()).toBe('0 * * * *')
})

test('custom: the raw text is sent as typed (trimmed)', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Custom')
  await typeInto(control(d(), 'Cron expression'), '  0 9 1 * *  ')
  await save()
  expect(createdCron()).toBe('0 9 1 * *')
})

test('custom with nothing typed is refused inline, nothing sent', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Custom')
  await save()
  expect(server.calls.create).toEqual([])
  expect(text(d())).toContain('Enter a cron expression')
})

// ── timezone default ────────────────────────────────────────────────────────

test("the timezone defaults to the browser's own zone when it is offered", async () => {
  const realTZ = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo')
    await openCreate()
    expect(shown(control(d(), 'Timezone'))).toContain('Asia/Tokyo')
    await fillBasics()
    await save()
    expect(server.calls.create[0]?.body.timezone).toBe('Asia/Tokyo')
  } finally {
    process.env.TZ = realTZ
  }
})

test('the timezone falls back to UTC when the browser zone is UTC', async () => {
  const realTZ = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    await openCreate()
    expect(shown(control(d(), 'Timezone'))).toBe('UTC')
    await fillBasics()
    await save()
    expect(server.calls.create[0]?.body.timezone).toBe('UTC')
  } finally {
    process.env.TZ = realTZ
  }
})

test('picking another timezone sends that one, and the preview is asked in it', async () => {
  await openCreate()
  await fillBasics()
  // The option's label carries Berlin's *current* offset (DST-dependent), so
  // it is looked up from the same list the picker renders rather than
  // hard-coded.
  const { timezoneOptions } = await import('../src/shared/lib/timezones')
  const berlin = timezoneOptions().find((z) => z.value === 'Europe/Berlin')
  if (!berlin) throw new Error('Europe/Berlin not offered')
  await choose(control(d(), 'Timezone'), berlin.label)
  await flushPreview()
  expect(server.calls.preview.at(-1)).toEqual({
    cron: '0 9 * * *',
    timezone: 'Europe/Berlin',
    count: 5,
  })
  await save()
  expect(server.calls.create[0]?.body.timezone).toBe('Europe/Berlin')
})

// ── orchestrator required ───────────────────────────────────────────────────

test('orchestrator is required: no POST, and the field says so', async () => {
  await openCreate()
  await typeInto(control(d(), 'Name'), 'Job')
  await typeInto(control(d(), 'Prompt'), 'Do it')
  await save()
  expect(server.calls.create).toEqual([])
  expect(dialog()).not.toBeNull()
  const trigger = control(d(), 'Orchestrator')
  expect(trigger.getAttribute('aria-invalid')).toBe('true')
  expect(text(d())).toContain('Choose an orchestrator')
})

test('only library orchestrators are offered, not subagents', async () => {
  await openCreate()
  await click(control(d(), 'Orchestrator'), 'orchestrator trigger')
  const options = [...document.body.querySelectorAll('[role="option"]')].map(text)
  expect(options).toEqual([optionLead()])
})

test('name and prompt are required too', async () => {
  await openCreate()
  await choose(control(d(), 'Orchestrator'), optionLead())
  await save()
  expect(server.calls.create).toEqual([])
  expect(text(d())).toContain('Give the automation a name')
  expect(text(d())).toContain('Write a prompt for this automation to run')
})

// ── preview: debounced, invalid, 400 ────────────────────────────────────────

test('the preview is debounced: a burst of keystrokes sends one request, for the final text', async () => {
  await openCreate()
  // Nothing goes out before the debounce elapses, even on open.
  expect(server.calls.preview).toEqual([])
  await flushPreview()
  expect(server.calls.preview).toEqual([
    { cron: '0 9 * * *', timezone: expect.any(String), count: 5 },
  ])

  await choose(kindTrigger(), 'Custom')
  for (const partial of ['0', '0 ', '0 9', '0 9 *', '0 9 * *', '0 9 * * 1']) {
    await typeInto(control(d(), 'Cron expression'), partial)
  }
  // Six keystrokes and a kind change: still only the one request from before,
  // and exactly one debounce timer waiting.
  expect(server.calls.preview).toHaveLength(1)
  expect(pendingDebounces).toHaveLength(1)

  await flushPreview()
  expect(server.calls.preview.map((c) => c.cron)).toEqual(['0 9 * * *', '0 9 * * 1'])
})

test('the preview lists the next runs it was given', async () => {
  server.preview = () => ({
    valid: true,
    error: null,
    nextRuns: ['2026-10-06T09:00:00.000Z', '2026-10-07T09:00:00.000Z', '2026-10-08T09:00:00.000Z'],
  })
  await openCreate()
  await flushPreview()
  const runsSection = [...d().querySelectorAll('label')].find(
    (l) => text(l) === 'Next runs',
  )?.parentElement
  expect(runsSection?.querySelectorAll('li')).toHaveLength(3)
})

test("an invalid preview shows the server's error and disables Save; fixing it re-enables Save", async () => {
  server.preview = (body) =>
    body.cron === 'bogus'
      ? { valid: false, error: 'Expected 5 fields, got 1', nextRuns: [] }
      : { valid: true, error: null, nextRuns: ['2026-10-06T09:00:00.000Z'] }
  await openCreate()
  await fillBasics()
  await flushPreview()
  expect(saveButton().disabled).toBe(false)

  await choose(kindTrigger(), 'Custom')
  await typeInto(control(d(), 'Cron expression'), 'bogus')
  await flushPreview()

  expect(text(d())).toContain('Expected 5 fields, got 1')
  expect(saveButton().disabled).toBe(true)
  await save()
  expect(server.calls.create).toEqual([])

  await typeInto(control(d(), 'Cron expression'), '0 9 * * *')
  await flushPreview()
  expect(text(d())).not.toContain('Expected 5 fields, got 1')
  expect(saveButton().disabled).toBe(false)
})

test('an invalid preview with no error text falls back to the generic message', async () => {
  server.preview = () => ({ valid: false, error: null, nextRuns: [] })
  await openCreate()
  await flushPreview()
  expect(text(d())).toContain('This schedule is not valid.')
  expect(saveButton().disabled).toBe(true)
})

test('a server 400 on create is shown in the dialog, which stays open', async () => {
  server.createFailure = {
    response: { status: 400, data: { error: 'Cron fires more often than every 5 minutes' } },
  }
  await openCreate()
  await fillBasics()
  await save()
  expect(server.calls.create).toHaveLength(1)
  expect(dialog()).not.toBeNull()
  expect(text(d())).toContain('Cron fires more often than every 5 minutes')
})

test('a 400 with validation issues lists them', async () => {
  server.createFailure = {
    response: {
      status: 400,
      data: { error: 'Invalid', issues: [{ path: 'cron', message: 'bad cron' }] },
    },
  }
  await openCreate()
  await fillBasics()
  await save()
  expect(text(d())).toContain('cron: bad cron')
})

test('Start paused sends paused: true; base branch and budget are sent when given', async () => {
  await openCreate()
  await fillBasics()
  await typeInto(control(d(), 'Base branch'), 'develop')
  await typeInto(control(d(), 'Spend cap (USD)'), '25')
  await click(d().querySelector('#automation-start-paused'), 'start paused switch')
  await save()
  expect(server.calls.create[0]?.body).toMatchObject({
    baseBranch: 'develop',
    maxBudgetUsd: 25,
    paused: true,
  })
})

// ── 4. edit ─────────────────────────────────────────────────────────────────

async function openEdit(a: ReturnType<typeof automation>) {
  server.automations = [a]
  m = await mountAt(routeTree, '/projects/p1/automations')
  await click(
    m.container.querySelector(`button[aria-label='Actions for "${a.name}"']`),
    'row actions',
  )
  await click(
    [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => text(el) === 'Edit'),
    'Edit menu item',
  )
  expect(text(d().querySelector('[data-slot="dialog-title"]'))).toBe('Edit automation')
}

test('edit pre-fills name, prompt, timezone, orchestrator and a weekdays cron', async () => {
  await openEdit(
    automation({
      name: 'Morning',
      prompt: 'Summarise overnight',
      cron: '30 7 * * 1-5',
      timezone: 'Europe/Berlin',
      orchestrator: 'lead',
      baseBranch: 'develop',
      maxBudgetUsd: 10,
    }),
  )
  expect((control(d(), 'Name') as HTMLInputElement).value).toBe('Morning')
  expect((control(d(), 'Prompt') as HTMLTextAreaElement).value).toBe('Summarise overnight')
  expect(shown(kindTrigger())).toBe('Weekdays (Mon–Fri)')
  expect(timeInput().value).toBe('07:30')
  expect(shown(control(d(), 'Timezone'))).toContain('Europe/Berlin')
  expect(shown(control(d(), 'Orchestrator'))).toBe('lead')
  expect((control(d(), 'Base branch') as HTMLInputElement).value).toBe('develop')
  expect((control(d(), 'Spend cap (USD)') as HTMLInputElement).value).toBe('10')
  // Start paused is create-only.
  expect(d().querySelector('#automation-start-paused')).toBeNull()
})

test('edit: "0 9 * * 1,3,5" re-opens as Specific days with Mon/Wed/Fri ticked', async () => {
  await openEdit(automation({ cron: '0 9 * * 1,3,5' }))
  expect(shown(kindTrigger())).toBe('Specific days')
  expect(timeInput().value).toBe('09:00')
  expect(tickedDays()).toEqual(['Mon', 'Wed', 'Fri'])
})

test('edit: "0 9 * * 0,6" re-opens as Weekends', async () => {
  await openEdit(automation({ cron: '0 9 * * 0,6' }))
  expect(shown(kindTrigger())).toBe('Weekends (Sat, Sun)')
})

test('edit: "15 */3 * * *" re-opens as Every N hours, 3, minute 15', async () => {
  await openEdit(automation({ cron: '15 */3 * * *' }))
  expect(shown(kindTrigger())).toBe('Every N hours')
  expect(shown(control(d(), 'Every N hours'))).toBe('3')
  expect((control(d(), 'Minute') as HTMLInputElement).value).toBe('15')
})

test('edit: a non-canonical "0 9 1 * *" lands in Custom with the raw text intact, and is saved unchanged', async () => {
  await openEdit(automation({ id: 'a1', cron: '0 9 1 * *' }))
  expect(shown(kindTrigger())).toBe('Custom')
  expect((control(d(), 'Cron expression') as HTMLInputElement).value).toBe('0 9 1 * *')
  await save()
  expect(server.calls.patch).toHaveLength(1)
  expect(server.calls.patch[0]?.body.cron).toBe('0 9 1 * *')
})

test('edit: Save sends a PATCH with the edited values', async () => {
  await openEdit(
    automation({
      id: 'a1',
      name: 'Morning',
      prompt: 'Old prompt',
      cron: '0 9 * * *',
      timezone: 'UTC',
      orchestrator: 'lead',
    }),
  )
  await typeInto(control(d(), 'Name'), 'Evening')
  await typeInto(control(d(), 'Prompt'), 'New prompt')
  await choose(kindTrigger(), 'Weekends (Sat, Sun)')
  await typeInto(timeInput(), '18:45')
  await save()

  expect(server.calls.create).toEqual([])
  expect(server.calls.patch).toEqual([
    {
      id: 'a1',
      body: {
        name: 'Evening',
        prompt: 'New prompt',
        cron: '45 18 * * 0,6',
        timezone: 'UTC',
        orchestrator: 'lead',
        baseBranch: null,
        maxBudgetUsd: null,
      },
    },
  ])
  expect(dialog()).toBeNull()
  expect(text(m.container.querySelector('tbody'))).toContain('Evening')
  expect(text(m.container.querySelector('tbody'))).toContain('Weekends at 18:45')
})

test('edit: a server error on save is shown, and the dialog stays open', async () => {
  server.patchFailure = { response: { status: 400, data: { error: 'Unknown orchestrator' } } }
  await openEdit(automation({ id: 'a1' }))
  await save()
  expect(server.calls.patch).toHaveLength(1)
  expect(dialog()).not.toBeNull()
  expect(text(d())).toContain('Unknown orchestrator')
})

test('edit: "0 */5 * * *" (a step the picker does not list) shows 5 and saves unchanged', async () => {
  await openEdit(automation({ id: 'a1', cron: '0 */5 * * *' }))
  expect(shown(kindTrigger())).toBe('Every N hours')
  expect(shown(control(d(), 'Every N hours'))).toBe('5')
  await save()
  expect(server.calls.patch[0]?.body.cron).toBe('0 */5 * * *')
})

test('the minute field clamps to 0..59', async () => {
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Every N hours')
  await typeInto(control(d(), 'Minute'), '75')
  await save()
  expect(createdCron()).toBe('59 * * * *')
})

test('Save stays disabled while an invalid cron is being re-checked', async () => {
  let release: (r: { valid: boolean; error: string | null; nextRuns: string[] }) => void = () => {}
  server.preview = (body) =>
    body.cron.startsWith('bogus')
      ? body.cron === 'bogus'
        ? { valid: false, error: 'Expected 5 fields, got 1', nextRuns: [] }
        : new Promise((resolve) => {
            release = resolve
          })
      : { valid: true, error: null, nextRuns: [] }
  await openCreate()
  await fillBasics()
  await choose(kindTrigger(), 'Custom')
  await typeInto(control(d(), 'Cron expression'), 'bogus')
  await flushPreview()
  expect(saveButton().disabled).toBe(true)

  // Still invalid, and the server has not answered yet.
  await typeInto(control(d(), 'Cron expression'), 'bogus2')
  await flushPreview()
  expect(saveButton().disabled).toBe(true)
  await save()
  expect(server.calls.create).toEqual([])

  await act(async () => {
    release({ valid: false, error: 'Expected 5 fields, got 1', nextRuns: [] })
  })
  await settle()
  expect(saveButton().disabled).toBe(true)
})
