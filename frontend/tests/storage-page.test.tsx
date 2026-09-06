// The storage dashboard's riskiest bits: the per-class counters and the
// cleanup confirmation's own "is there anything to show at all" branch (the
// exact counts and bytes it states are covered on their own, straight off
// `cleanupPlanFor`, in tests/storage-cleanup-plan.test.ts — `t()` never
// interpolates its params without a real i18next instance in this
// environment, so a DOM assertion here could only ever prove the dialog
// picked the right *template*, never the right *numbers*), per-row delete
// and recheck, and bulk selection producing an explicit id list rather than
// the class-filter-as-selection workaround this replaces.
//
// Every anomaly fixture below carries `sessionId: null` on purpose: a real
// one would upgrade to a `<Link>` from `@tanstack/react-router`, which throws
// outside a mounted router — a session-scoped anomaly is exactly the case
// this file has no need to exercise to prove any of the above. The one
// exception is the top-sessions table, which always names a real session by
// contract (`topSessions[].sessionId` is never null) — `getApiSessionsId` is
// mocked to fail there, which is what already makes `SessionRefLink` render
// its no-router-needed "session gone" fallback for the anomalies table too.

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// Same identity-proxy loader, same allowlist, as tests/ui-core.test.tsx,
// tests/transcript-row.test.tsx and tests/transcript-time.test.tsx: `StoragePage`
// pulls in the `@/shared/ui` barrel too, and whichever of them `bun test`
// evaluates first decides how those ten modules are cached for the run — see
// the long note in transcript-time.test.tsx. Copied verbatim, not widened.
import { plugin } from 'bun'

const UI_CORE_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'storage-page-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: UI_CORE_STYLES }, () => ({
      contents:
        'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type Query = Record<string, unknown> | undefined

const T = '2026-09-04T10:00:00.000Z'

const anomaly = (o: Record<string, unknown>) => ({
  sessionId: null,
  fileId: null,
  path: null,
  originalFilename: null,
  detail: null,
  firstSeenAt: T,
  lastSeenAt: T,
  resolvedAt: null,
  ...o,
})

const OPEN = [
  anomaly({ id: 'a1', class: 'orphan_blob', path: '/x', originalFilename: 'x.bin', sizeBytes: 100_000_000 }),
  anomaly({ id: 'a2', class: 'orphan_blob', path: '/y', originalFilename: 'y.bin', sizeBytes: 112_000_000 }),
  anomaly({ id: 'a3', class: 'dangling_row', fileId: 'f3', originalFilename: 'z.txt', sizeBytes: 50 }),
  anomaly({
    id: 'a4',
    class: 'checksum_mismatch',
    fileId: 'f4',
    originalFilename: 'w.txt',
    sizeBytes: 999,
  }),
]
const RESOLVED = [anomaly({ id: 'a5', class: 'orphan_session_dir', path: '/gone', resolvedAt: T })]

// Reassignable per test — the mismatch-only regression case needs a fixture
// the default OPEN array does not provide (no orphan blob or dangling row to
// dilute the point being tested).
let openAnomalies: typeof OPEN = OPEN

const SUMMARY_CLIENT = '@/shared/api/generated/clients/getApiStorageSummary'
const ANOMALIES_CLIENT = '@/shared/api/generated/clients/getApiStorageAnomalies'
const SESSION_CLIENT = '@/shared/api/generated/clients/getApiSessionsId'
const DELETE_CLIENT = '@/shared/api/generated/clients/postApiStorageAnomaliesIdDelete'
const RECHECK_CLIENT = '@/shared/api/generated/clients/postApiStorageAnomaliesIdRecheck'
const BULK_DELETE_CLIENT = '@/shared/api/generated/clients/postApiStorageAnomaliesBulkDelete'
const BULK_CLIENT = '@/shared/api/generated/clients/postApiStorageAnomaliesBulk'

const realSummary = await import('../src/shared/api/generated/clients/getApiStorageSummary')
const realAnomalies = await import('../src/shared/api/generated/clients/getApiStorageAnomalies')
const realSession = await import('../src/shared/api/generated/clients/getApiSessionsId')
const realDelete = await import('../src/shared/api/generated/clients/postApiStorageAnomaliesIdDelete')
const realRecheck = await import(
  '../src/shared/api/generated/clients/postApiStorageAnomaliesIdRecheck'
)
const realBulkDelete = await import(
  '../src/shared/api/generated/clients/postApiStorageAnomaliesBulkDelete'
)
const realBulk = await import('../src/shared/api/generated/clients/postApiStorageAnomaliesBulk')

await mock.module(SUMMARY_CLIENT, () => ({
  getApiStorageSummary: async () => ({
    data: {
      totalBytes: 212_000_050,
      totalFiles: 4,
      sessionCount: 2,
      maxTotalBytes: 1_000_000_000,
      openAnomalies: OPEN.length,
      lastCheckAt: T,
      lastCleanupAt: null,
      topSessions: [
        { sessionId: 'sess-large', sizeBytes: 150_000_000, fileCount: 12 },
        { sessionId: 'sess-small', sizeBytes: 2_000, fileCount: 1 },
      ],
      nextCheckAt: '2026-09-04T11:00:00.000Z',
    },
  }),
}))

await mock.module(ANOMALIES_CLIENT, () => ({
  getApiStorageAnomalies: async (opts: { query?: Query }) => {
    const query = opts.query ?? {}
    let rows = query.resolved === 'true' ? RESOLVED : openAnomalies
    if (query.class) rows = rows.filter((r) => r.class === query.class)
    return { data: rows }
  },
}))

// No test in this file exercises a real, resolvable session — see the file's
// own header comment — so this always answers "not found", which is what
// lets `SessionRefLink` render its no-router-needed fallback everywhere.
await mock.module(SESSION_CLIENT, () => ({
  getApiSessionsId: async () => {
    throw new Error('no session in this test')
  },
}))

let deleteCalls: { id: string }[] = []
let deleteOutcome: 'deleted' | 'revalidated' | 'unchanged' | 'failed' = 'deleted'
let deleteError: string | undefined

await mock.module(DELETE_CLIENT, () => ({
  postApiStorageAnomaliesIdDelete: async (opts: { path: { id: string } }) => {
    deleteCalls.push(opts.path)
    const row = openAnomalies.find((a) => a.id === opts.path.id) ?? openAnomalies[0]
    return { data: { anomaly: row, outcome: deleteOutcome, error: deleteError } }
  },
}))

let recheckCalls: { id: string }[] = []
let recheckOutcome: 'deleted' | 'revalidated' | 'unchanged' | 'failed' = 'unchanged'

await mock.module(RECHECK_CLIENT, () => ({
  postApiStorageAnomaliesIdRecheck: async (opts: { path: { id: string } }) => {
    recheckCalls.push(opts.path)
    const row = openAnomalies.find((a) => a.id === opts.path.id) ?? openAnomalies[0]
    return { data: { anomaly: row, outcome: recheckOutcome } }
  },
}))

let bulkDeleteCalls: { ids?: string[] }[] = []
let bulkDeleteResults: { outcome: string }[] = [{ outcome: 'deleted' }]

await mock.module(BULK_DELETE_CLIENT, () => ({
  postApiStorageAnomaliesBulkDelete: async (opts: { body?: { ids?: string[] } }) => {
    bulkDeleteCalls.push(opts.body ?? {})
    return { data: { results: bulkDeleteResults } }
  },
}))

let bulkResolveCalls: { ids?: string[]; class?: string }[] = []

await mock.module(BULK_CLIENT, () => ({
  postApiStorageAnomaliesBulk: async (opts: { body?: { ids?: string[]; class?: string } }) => {
    bulkResolveCalls.push(opts.body ?? {})
    return { data: { resolved: opts.body?.ids?.length ?? 0 } }
  },
}))

afterAll(async () => {
  await mock.module(SUMMARY_CLIENT, () => realSummary)
  await mock.module(ANOMALIES_CLIENT, () => realAnomalies)
  await mock.module(SESSION_CLIENT, () => realSession)
  await mock.module(DELETE_CLIENT, () => realDelete)
  await mock.module(RECHECK_CLIENT, () => realRecheck)
  await mock.module(BULK_DELETE_CLIENT, () => realBulkDelete)
  await mock.module(BULK_CLIENT, () => realBulk)
})

const { StoragePage } = await import('../src/features/storage/components/storage-page')
const { Toaster, toaster } = await import('../src/shared/ui/overlay/toast')

let client: QueryClient
let container: HTMLDivElement
let root: Root

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Toaster />
        <StoragePage />
      </QueryClientProvider>,
    )
  })
  // The several queries (summary, open anomalies, unfiltered open anomalies)
  // each resolve over their own chain of microtasks; several real timer
  // ticks is what reliably outlasts all of them (see the same idiom in
  // tests/use-session-files.test.tsx's own `flush`).
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const unmount = async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
  // The toaster is a module-level singleton (see toast.tsx), so a toast this
  // test created would otherwise still be alive — and its `<Toaster />`
  // subscriber still registered — for whatever the *next* test's own
  // `mount()` renders on top of it.
  toaster.remove()
}

beforeEach(() => {
  openAnomalies = OPEN
  deleteCalls = []
  deleteOutcome = 'deleted'
  deleteError = undefined
  recheckCalls = []
  recheckOutcome = 'unchanged'
  bulkDeleteCalls = []
  bulkDeleteResults = [{ outcome: 'deleted' }]
  bulkResolveCalls = []
})

afterEach(unmount)

/** Every `dt` -> its sibling `dd`'s text, so a count can be asked for by the
 *  term's own (untranslated, in this environment) key rather than position. */
function definitions() {
  const map = new Map<string | null, string>()
  for (const dt of container.querySelectorAll('dt')) {
    map.set(dt.textContent, dt.nextElementSibling?.textContent ?? '')
  }
  return map
}

const buttons = () => [...container.querySelectorAll('button')]
const findButton = (text: string) => buttons().find((b) => b.textContent?.includes(text))
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** The row checkboxes the "select" column renders, in row order — table row
 *  order matches `openAnomalies` order (no sort applied), so index 0 is
 *  always a1. */
const rowCheckboxes = () =>
  [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]

const selectRow = async (index: number) => {
  const input = rowCheckboxes()[index]
  if (!input) throw new Error(`no row checkbox at index ${index}`)
  await act(async () => {
    input.click()
  })
}

/** Every menu trigger on the page, in row order — one `ActionsMenu` per open
 *  row (see the "actions" column). */
const menuTriggers = () =>
  [...container.querySelectorAll('button[aria-haspopup="menu"]')] as HTMLElement[]

/**
 * Opens the row's menu and selects the item whose label is `label`.
 *
 * Two events, each its own `act`: Zag's menu machine sets `highlightedValue`
 * off `ITEM_POINTERDOWN` and reads it back synchronously handling
 * `ITEM_CLICK` — a `pointerdown` and a `click` dispatched inside the *same*
 * `act` land before that machine transition has actually applied, and the
 * click fires against a `highlightedValue` that is still unset.
 */
async function selectRowMenuItem(rowIndex: number, label: string) {
  const trigger = menuTriggers()[rowIndex]
  if (!trigger) throw new Error(`no menu trigger at row ${rowIndex}`)
  await act(async () => {
    trigger.click()
  })
  const items = [
    ...document.body.querySelectorAll('[role="menu"][data-state="open"] [role="menuitem"]'),
  ] as HTMLElement[]
  const item = items.find((el) => el.textContent === label)
  if (!item) {
    throw new Error(`no open menu item "${label}" among ${items.map((i) => i.textContent).join(', ')}`)
  }
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
  })
  await act(async () => {
    item.click()
  })
}

/**
 * Ark's Dialog (and therefore ConfirmDialog) renders through a Portal,
 * straight onto `document.body`, never inside `container` — and, per
 * dialog.tsx's own note, never unmounts its Content on close either. This
 * page renders five `ConfirmDialog`s unconditionally, so a bare
 * `[role="alertdialog"]` always matches one of them, open or not; the
 * `data-state="open"` qualifier is load-bearing, not decoration.
 */
const dialogButtons = () => {
  const dialog = document.body.querySelector('[role="alertdialog"][data-state="open"]')
  return dialog ? ([...dialog.querySelectorAll('button')] as HTMLElement[]) : []
}
const findDialogButton = (text: string) => dialogButtons().find((b) => b.textContent?.includes(text))

test('the summary card counts each anomaly class from the unfiltered open list', async () => {
  await mount()
  const defs = definitions()
  expect(defs.get('storage.classes.orphan_blob')).toBe('2')
  expect(defs.get('storage.classes.dangling_row')).toBe('1')
  expect(defs.get('storage.classes.orphan_session_dir')).toBe('0')
  expect(defs.get('storage.classes.checksum_mismatch')).toBe('1')
  expect(defs.get('storage.summary.openAnomalies')).toBe('4')
})

test('the summary card shows the next scheduled check, not "not scheduled"', async () => {
  await mount()
  expect(container.textContent).not.toContain('storage.summary.notScheduled')
})

test('the largest-sessions table renders each session\'s bytes and file count', async () => {
  await mount()
  expect(container.textContent).toContain('143 MB')
  expect(container.textContent).toContain('12')
  expect(container.textContent).toContain('2.0 KB')
})

test('the cleanup confirmation shows the real body, not "nothing to clean up", when only a checksum_mismatch is open', async () => {
  // The regression this track fixes: cleanup used to report checksum_mismatch
  // only and never remediate it, so a store with nothing BUT a mismatch
  // planned zero deletions and showed the empty-state copy — a lie, since
  // gc.ts's `runCleanup` deletes the corrupt blob and row for that class too.
  openAnomalies = [
    anomaly({ id: 'm1', class: 'checksum_mismatch', fileId: 'f1', sizeBytes: 999 }),
  ]
  await mount()
  const cleanupButton = findButton('storage.cleanupEverything')
  if (!cleanupButton) throw new Error('no cleanup button')
  await click(cleanupButton)

  const body = document.body.textContent ?? ''
  expect(body).toContain('storage.cleanupConfirm.body')
  expect(body).not.toContain('storage.cleanupConfirm.empty')
})

test('every open row carries an actions trigger; the "Resolve" action only exists for one still open', async () => {
  await mount()

  const triggers = container.querySelectorAll('[aria-label="storage.anomalies.actionsFor"]')
  // One per open row (a1..a4) — none of them resolved.
  expect(triggers.length).toBe(4)
})

// --- per-row recheck --------------------------------------------------------

test('recheck fires for exactly the row it was chosen from, not the first or every row', async () => {
  recheckOutcome = 'unchanged'
  await mount()

  await selectRowMenuItem(2, 'storage.anomalies.recheck')

  expect(recheckCalls).toEqual([{ id: 'a3' }])
  // Recheck deletes nothing, so it never asks for confirmation first.
  expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).toBeNull()
})

test('a recheck that finds the anomaly fixed itself reports that honestly, not as a deletion', async () => {
  recheckOutcome = 'revalidated'
  await mount()

  await selectRowMenuItem(0, 'storage.anomalies.recheck')

  expect(recheckCalls).toEqual([{ id: 'a1' }])
  expect(document.body.textContent).toContain('storage.anomalies.outcome.revalidated')
})

// --- per-row delete ----------------------------------------------------------

test('delete asks for confirmation before calling anything', async () => {
  await mount()
  await selectRowMenuItem(0, 'storage.anomalies.delete')

  expect(deleteCalls).toEqual([])
  expect(document.body.querySelector('[role="alertdialog"][data-state="open"]')).not.toBeNull()
})

test('confirming delete fires for exactly the row it was chosen from', async () => {
  deleteOutcome = 'deleted'
  await mount()
  await selectRowMenuItem(1, 'storage.anomalies.delete')

  const confirm = findDialogButton('storage.anomalies.delete')
  if (!confirm) throw new Error('no confirm button in the delete dialog')
  await click(confirm)

  expect(deleteCalls).toEqual([{ id: 'a2' }])
})

test('a delete that failed is reported, not swallowed as if it succeeded', async () => {
  deleteOutcome = 'failed'
  deleteError = 'disk is unhappy'
  await mount()
  await selectRowMenuItem(0, 'storage.anomalies.delete')
  const confirm = findDialogButton('storage.anomalies.delete')
  if (!confirm) throw new Error('no confirm button in the delete dialog')
  await click(confirm)

  expect(document.body.textContent).toContain('storage.anomalies.outcome.failed')
  expect(document.body.textContent).toContain('disk is unhappy')
})

// --- bulk selection ----------------------------------------------------------

test('the bulk buttons stay disabled until a row is selected', async () => {
  await mount()
  const resolveSelected = findButton('storage.anomalies.resolveSelected')
  const deleteSelected = findButton('storage.anomalies.deleteSelected')
  expect(resolveSelected?.hasAttribute('disabled')).toBe(true)
  expect(deleteSelected?.hasAttribute('disabled')).toBe(true)

  await selectRow(0)

  expect(resolveSelected?.hasAttribute('disabled')).toBe(false)
  expect(deleteSelected?.hasAttribute('disabled')).toBe(false)
})

test('bulk delete acts on exactly the rows checked — an explicit id list, not the class filter', async () => {
  await mount()
  // a1 and a3: neither the first two rows nor rows sharing a class, so an
  // implementation that quietly fell back to "everything of this class" or
  // "the first N" would be caught rather than coincidentally passing.
  await selectRow(0)
  await selectRow(2)

  const deleteSelected = findButton('storage.anomalies.deleteSelected')
  if (!deleteSelected) throw new Error('no delete-selected button')
  await click(deleteSelected)

  const confirm = findDialogButton('storage.anomalies.deleteSelected')
  if (!confirm) throw new Error('no confirm button in the delete-selected dialog')
  await click(confirm)

  expect(bulkDeleteCalls).toEqual([{ ids: ['a1', 'a3'] }])
})

test('bulk resolve also acts on an explicit id list', async () => {
  await mount()
  await selectRow(1)
  await selectRow(3)

  const resolveSelected = findButton('storage.anomalies.resolveSelected')
  if (!resolveSelected) throw new Error('no resolve-selected button')
  await click(resolveSelected)

  const confirm = findDialogButton('storage.anomalies.resolveSelected')
  if (!confirm) throw new Error('no confirm button in the resolve-selected dialog')
  await click(confirm)

  expect(bulkResolveCalls).toEqual([{ ids: ['a2', 'a4'] }])
})

test('a mixed bulk-delete result reports every outcome, not just the good news', async () => {
  bulkDeleteResults = [{ outcome: 'deleted' }, { outcome: 'deleted' }, { outcome: 'failed' }]
  await mount()
  await selectRow(0)
  await selectRow(1)
  await selectRow(2)

  const deleteSelected = findButton('storage.anomalies.deleteSelected')
  if (!deleteSelected) throw new Error('no delete-selected button')
  await click(deleteSelected)
  const confirm = findDialogButton('storage.anomalies.deleteSelected')
  if (!confirm) throw new Error('no confirm button in the delete-selected dialog')
  await click(confirm)

  const toastText = document.body.textContent ?? ''
  expect(toastText).toContain('2')
  expect(toastText).toContain('storage.anomalies.outcomeShort.deleted')
  expect(toastText).toContain('1')
  expect(toastText).toContain('storage.anomalies.outcomeShort.failed')
})
