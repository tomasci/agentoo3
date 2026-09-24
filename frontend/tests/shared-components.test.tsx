// Each hand-written composition in `@/shared/components`, built from
// `@/shared/ui/*` (shadcn/Base UI) parts. Assertions are by attribute, role
// or DOM structure wherever the behaviour is observable that way. The
// exceptions are layout contracts happy-dom cannot compute (it performs no
// layout at all) — truncation, track sizing, wrapping — where the utility
// class *is* the only observable, and each such assertion says which
// behaviour the class stands for.
//
// Mounted under a private `cimode` i18next instance (i18next's own
// always-return-the-key mode) via `I18nextProvider`, and deliberately never
// `import '@/shared/i18n'`: ConfirmDialog, ActionsMenu and CopyButton call
// `t()` for their built-in copy, and without a provider of its own this file
// would read react-i18next's process-wide default — raw keys if it runs
// before any file that imports the app's singleton (directly or through
// `src/app/router`), real English after. The instance below makes `t()`
// return the key whatever ran first, so copy is asserted exactly. Never
// `.use(initReactI18next)` on it — see tests/settings-page.test.tsx.

import { afterEach, expect, test } from 'bun:test'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import i18next from 'i18next'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
  ActionsMenu,
  Code,
  ConfirmDialog,
  CopyButton,
  DataTable,
  DefinitionList,
  Loading,
  type MenuAction,
  PageHeader,
  StatusBadge,
  StatusDot,
} from '@/shared/components'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

let root: Root | undefined
let host: HTMLElement

async function mount(ui: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>)
  })
}

/** Parses static markup into a detached tree, so structure can be queried
 *  rather than substring-matched. */
function dom(ui: ReactNode): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>)
  return el
}

const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/)

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

// --- StatusDot ---

test('StatusDot is aria-hidden and carries its tone', () => {
  const success = renderToStaticMarkup(<StatusDot tone="success" />)
  const danger = renderToStaticMarkup(<StatusDot tone="danger" />)
  expect(success).toContain('aria-hidden="true"')
  expect(success).toContain('bg-green-500')
  expect(danger).toContain('bg-destructive')
  expect(danger).not.toContain('bg-green-500')
})

test('StatusDot only animates when pulse is set', () => {
  const still = renderToStaticMarkup(<StatusDot tone="warning" />)
  const pulsing = renderToStaticMarkup(<StatusDot tone="warning" pulse />)
  expect(still).not.toContain('animate-pulse')
  expect(pulsing).toContain('animate-pulse')
})

// --- StatusBadge ---

test('StatusBadge renders an outline badge with a tone dot and its children', () => {
  const out = renderToStaticMarkup(<StatusBadge tone="success">Ready</StatusBadge>)
  expect(out).toContain('data-slot="badge"')
  expect(out).toContain('data-variant="outline"')
  expect(out).toContain('bg-green-500')
  expect(out).toContain('Ready')
})

// --- Loading ---

test('Loading announces role=status with a visible label next to a decorative spinner', () => {
  const out = renderToStaticMarkup(<Loading label="Loading sessions" />)
  expect(out).toContain('role="status"')
  expect(out).toContain('Loading sessions')
  expect(out).toContain('data-slot="spinner"')
})

// --- CopyButton ---

test('CopyButton copies the value to the clipboard and shows a transient confirmation', async () => {
  await mount(<CopyButton value="ssh-ed25519 AAAA..." label="Copy key" />)
  const button = host.querySelector('button') as HTMLButtonElement
  expect(button.textContent).toContain('Copy key')

  await act(async () => {
    button.click()
    await Promise.resolve()
  })
  await flush()

  // Exact now that this file owns its i18n instance — see the file header.
  // It used to be a case-insensitive /copied/i, because whether `t()` gave
  // "Copied" or the key depended on which file had run first.
  expect(button.textContent).toContain('common.copied')
  expect(button.textContent).not.toContain('Copy key')
  expect(await navigator.clipboard.readText()).toBe('ssh-ed25519 AAAA...')
})

// --- ConfirmDialog ---

test('ConfirmDialog cancel closes the dialog without confirming', async () => {
  let open = true
  let confirmed = false
  await mount(
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        open = next
      }}
      title="Delete project"
      description="This cannot be undone."
      onConfirm={() => {
        confirmed = true
      }}
    />,
  )
  const cancel = document.querySelector('[data-slot="alert-dialog-cancel"]') as HTMLElement
  await act(async () => {
    cancel.click()
  })
  expect(open).toBe(false)
  expect(confirmed).toBe(false)
})

test('ConfirmDialog confirm runs onConfirm — and, being a plain Button rather than a Close, does not close the dialog itself', async () => {
  let confirmCount = 0
  await mount(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete project"
      description="This cannot be undone."
      onConfirm={() => {
        confirmCount += 1
      }}
    />,
  )
  const confirm = document.querySelector('[data-slot="alert-dialog-action"]') as HTMLElement
  await act(async () => {
    confirm.click()
  })
  expect(confirmCount).toBe(1)
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
})

test('ConfirmDialog busy disables confirm and shows a spinner, leaving the dialog open', async () => {
  await mount(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete project"
      description="This cannot be undone."
      busy
      onConfirm={() => {}}
    />,
  )
  const confirm = document.querySelector('[data-slot="alert-dialog-action"]') as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  expect(confirm.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
})

// --- ActionsMenu ---

test('ActionsMenu renders nothing when there are no actions — a dead-end trigger is not an empty state', () => {
  const out = renderToStaticMarkup(<ActionsMenu actions={[]} />)
  expect(out).toBe('')
})

test('ActionsMenu opens on click and runs the selected action', async () => {
  const log: string[] = []
  const actions: MenuAction[] = [
    { id: 'open', label: 'Open', onSelect: () => log.push('open') },
    { id: 'delete', label: 'Delete', destructive: true, onSelect: () => log.push('delete') },
  ]
  await mount(<ActionsMenu actions={actions} label="Row actions" />)
  const trigger = host.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement
  await act(async () => {
    trigger.click()
  })
  await flush()

  const items = [...document.querySelectorAll('[role="menuitem"]')]
  expect(items.length).toBe(2)

  await act(async () => {
    ;(items[1] as HTMLElement).click()
  })
  expect(log).toEqual(['delete'])
})

// --- DataTable ---

interface Row {
  id: string
  name: string
}

const columnHelper = createColumnHelper<Row>()
const columns = [
  columnHelper.accessor('name', { header: () => 'Name', meta: { role: 'primary' } }),
  columnHelper.display({
    id: 'actions',
    header: () => '',
    meta: { role: 'actions' },
    cell: () => <button type="button">Open</button>,
  }),
]

function TestTable({ data, empty }: { data: Row[]; empty?: ReactNode }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} empty={empty} />
}

test('DataTable renders `empty` when the row model has no rows', () => {
  const out = renderToStaticMarkup(<TestTable data={[]} empty="No rows to show" />)
  expect(out).toContain('No rows to show')
  expect(out).not.toContain('<button')
})

test('DataTable renders rows and cells, right-aligning an actions column', () => {
  const out = renderToStaticMarkup(<TestTable data={[{ id: '1', name: 'agentoo' }]} />)
  expect(out).toContain('agentoo')
  expect(out).toContain('Open')
  expect(out).toContain('role="rowheader"')
  expect(out).toContain('text-right')
})

test('DataTable gives a secondary cell the truncation classes and its raw string value as a title', () => {
  interface Wide {
    id: string
    name: string
    path: string
  }
  const wide = createColumnHelper<Wide>()
  const LONG = '/srv/worktrees/a-very-long-unbroken-worktree-path-that-will-not-fit'
  function WideTable() {
    const table = useReactTable({
      data: [{ id: '1', name: 'agentoo', path: LONG }],
      columns: [
        wide.accessor('name', { header: () => 'Name', meta: { role: 'primary' } }),
        // The rendered cell deliberately differs from the raw value, so the
        // title can only have come from `getValue()`, not from the markup.
        wide.accessor('path', {
          header: () => 'Path',
          meta: { role: 'secondary' },
          cell: (info) => <em>{`path: ${info.getValue()}`}</em>,
        }),
      ],
      getCoreRowModel: getCoreRowModel(),
    })
    return <DataTable table={table} />
  }
  const el = dom(<WideTable />)
  const cells = [...el.querySelectorAll('tbody tr > *')]
  expect(cells).toHaveLength(2)
  const [primary, secondary] = cells

  // `truncate` ellipsizes; `w-full max-w-0` is what lets the column shrink
  // enough for there to be anything to ellipsize (see data-table.tsx).
  expect(classes(secondary)).toEqual(
    expect.arrayContaining(['lg:w-full', 'lg:max-w-0', 'lg:truncate']),
  )
  expect(secondary?.getAttribute('title')).toBe(LONG)
  expect(secondary?.textContent).toBe(`path: ${LONG}`)

  // Only the secondary cell: the primary one is neither clipped nor titled.
  expect(classes(primary)).not.toContain('lg:truncate')
  expect(primary?.hasAttribute('title')).toBe(false)
})

test('DataTable gives a secondary cell no title when its value is not a string', () => {
  interface Sized {
    id: string
    size: number
  }
  const sized = createColumnHelper<Sized>()
  function SizedTable() {
    const table = useReactTable({
      data: [{ id: '1', size: 4096 }],
      columns: [sized.accessor('size', { header: () => 'Size', meta: { role: 'secondary' } })],
      getCoreRowModel: getCoreRowModel(),
    })
    return <DataTable table={table} />
  }
  const cell = dom(<SizedTable />).querySelector('tbody td')
  expect(cell?.textContent).toBe('4096')
  expect(classes(cell)).toContain('lg:truncate')
  expect(cell?.hasAttribute('title')).toBe(false)
})

test('DataTable leaves a column with no role untruncated and untitled', () => {
  // projects-table.tsx's path column relies on exactly this: it omits `role`
  // so a path wraps (via <Code wrap>) instead of losing its tail to an
  // ellipsis.
  interface Plain {
    id: string
    path: string
  }
  const plain = createColumnHelper<Plain>()
  function PlainTable() {
    const table = useReactTable({
      data: [{ id: '1', path: '/srv/a' }],
      columns: [plain.accessor('path', { header: () => 'Path' })],
      getCoreRowModel: getCoreRowModel(),
    })
    return <DataTable table={table} />
  }
  const cell = dom(<PlainTable />).querySelector('tbody td')
  expect(cell?.textContent).toBe('/srv/a')
  expect(classes(cell)).not.toContain('lg:truncate')
  expect(cell?.hasAttribute('title')).toBe(false)
})

// --- ActionsMenu: disabled ---

test('ActionsMenu marks a disabled action disabled, and clicking it does not run it', async () => {
  const log: string[] = []
  const actions: MenuAction[] = [
    { id: 'open', label: 'Open', onSelect: () => log.push('open') },
    { id: 'delete', label: 'Delete', disabled: true, onSelect: () => log.push('delete') },
  ]
  await mount(<ActionsMenu actions={actions} />)
  const trigger = host.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement
  // No `label` given: the trigger falls back to the shared translated one.
  expect(trigger.getAttribute('aria-label')).toBe('common.actions')
  await act(async () => {
    trigger.click()
  })
  await flush()

  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map((i) => i.textContent)).toEqual(['Open', 'Delete'])
  const [enabled, disabled] = items
  expect(disabled?.getAttribute('aria-disabled')).toBe('true')
  expect(disabled?.hasAttribute('data-disabled')).toBe(true)
  expect(enabled?.hasAttribute('aria-disabled')).toBe(false)

  await act(async () => {
    disabled?.click()
  })
  await flush()
  expect(log).toEqual([])

  // The control: the enabled sibling in the same open menu does run, so the
  // empty log above is the disabled flag's doing, not a click that reaches
  // nothing.
  await act(async () => {
    enabled?.click()
  })
  expect(log).toEqual(['open'])
})

// --- Code ---

test('Code renders an inline token as a bare <code>, with no <pre> around it', () => {
  const el = dom(<Code>git status</Code>)
  expect(el.children).toHaveLength(1)
  const code = el.firstElementChild
  expect(code?.tagName).toBe('CODE')
  expect(code?.textContent).toBe('git status')
  expect(el.querySelector('pre') === null).toBe(true)
})

test('Code block renders <pre><code>, preserving the text exactly', () => {
  const text = 'line one\n  indented two\nline three'
  const el = dom(<Code block>{text}</Code>)
  expect(el.children).toHaveLength(1)
  const pre = el.firstElementChild
  expect(pre?.tagName).toBe('PRE')
  expect(pre?.children).toHaveLength(1)
  expect(pre?.firstElementChild?.tagName).toBe('CODE')
  expect(pre?.textContent).toBe(text)
})

test('Code only wraps long lines when asked to, inline and block alike', () => {
  // `whitespace-pre-wrap` keeps the text's own line breaks and spacing but
  // lets a line that overruns wrap; `break-words` breaks an unbroken token.
  // Without `wrap`, a block scrolls sideways instead (`overflow-x-auto`).
  const WRAP = ['whitespace-pre-wrap', 'break-words']
  const inline = dom(<Code>x</Code>).firstElementChild
  const inlineWrap = dom(<Code wrap>x</Code>).firstElementChild
  const block = dom(<Code block>x</Code>).firstElementChild
  const blockWrap = dom(
    <Code block wrap>
      x
    </Code>,
  ).firstElementChild

  for (const c of WRAP) {
    expect(classes(inline)).not.toContain(c)
    expect(classes(block)).not.toContain(c)
    expect(classes(inlineWrap)).toContain(c)
    expect(classes(blockWrap)).toContain(c)
  }
  expect(classes(block)).toContain('overflow-x-auto')
  // On a block the wrap classes go on the <pre>, which owns the whitespace
  // handling, and the <code> inside stays bare.
  expect(blockWrap?.tagName).toBe('PRE')
  expect(blockWrap?.firstElementChild?.getAttribute('class')).toBeNull()
})

// --- DefinitionList ---

const ITEMS = [
  { id: 'branch', term: 'Branch', description: 'main' },
  { id: 'path', term: 'Path', description: '/srv/worktrees/c8c096e7-9d23-46ef-a99b-e76efde8a714' },
  { id: 'status', term: 'Status', description: <strong>ready</strong> },
]

test('DefinitionList renders exactly one dt and one dd per item, paired in order', () => {
  const dl = dom(<DefinitionList items={ITEMS} />).querySelector('dl')
  expect(dl?.tagName).toBe('DL')
  const terms = [...(dl?.querySelectorAll('dt') ?? [])]
  const descriptions = [...(dl?.querySelectorAll('dd') ?? [])]
  expect(terms.map((t) => t.textContent)).toEqual(['Branch', 'Path', 'Status'])
  expect(descriptions.map((d) => d.textContent)).toEqual([
    'main',
    '/srv/worktrees/c8c096e7-9d23-46ef-a99b-e76efde8a714',
    'ready',
  ])
  // Each pair shares a wrapper, and the dd follows its own dt.
  for (const [i, dt] of terms.entries()) {
    expect(dt.nextElementSibling === descriptions[i]).toBe(true)
  }
  // A ReactNode description is rendered, not stringified.
  expect(descriptions[2]?.querySelector('strong')?.textContent).toBe('ready')
})

test('DefinitionList renders an empty list as an empty <dl>', () => {
  const dl = dom(<DefinitionList items={[]} />).querySelector('dl')
  expect(dl?.tagName).toBe('DL')
  expect(dl?.children).toHaveLength(0)
})

test('DefinitionList inline lays pairs out as grid columns from sm; stacked never does', () => {
  // happy-dom computes no layout, so the grid is asserted through the
  // utilities that produce it: a two-track grid on the <dl>, and
  // `display: contents` on each pair's wrapper so dt and dd join that grid
  // as its two columns rather than the wrapper taking a cell of its own.
  const inline = dom(<DefinitionList items={ITEMS} layout="inline" />).querySelector('dl')
  const byDefault = dom(<DefinitionList items={ITEMS} />).querySelector('dl')
  const stacked = dom(<DefinitionList items={ITEMS} layout="stacked" />).querySelector('dl')

  expect(classes(inline)).toEqual(
    expect.arrayContaining(['sm:grid', 'sm:grid-cols-[max-content_minmax(0,1fr)]']),
  )
  for (const pair of inline?.children ?? []) expect(classes(pair)).toContain('sm:contents')
  // `inline` is the default.
  expect(byDefault?.getAttribute('class')).toBe(inline?.getAttribute('class') ?? '')

  expect(classes(stacked)).toEqual(expect.arrayContaining(['flex', 'flex-col']))
  expect(classes(stacked).some((c) => c.includes('grid'))).toBe(false)
  for (const pair of stacked?.children ?? []) expect(classes(pair)).not.toContain('sm:contents')
})

test('DefinitionList lets the description track shrink, so a long unbroken token wraps instead of overflowing', () => {
  // Three pieces have to line up (definition-list.tsx): the track is
  // `minmax(0,1fr)`, not `1fr` (which floors at min-content), the dd is
  // `min-w-0` (a grid item's own min-width defaults to auto), and
  // `wrap-anywhere` breaks the token once there is room to. Missing any one
  // of them, the path below pushes the row wider than its container.
  for (const layout of ['inline', 'stacked'] as const) {
    const dl = dom(<DefinitionList items={ITEMS} layout={layout} />).querySelector('dl')
    for (const dd of dl?.querySelectorAll('dd') ?? []) {
      expect(classes(dd)).toEqual(expect.arrayContaining(['min-w-0', 'wrap-anywhere']))
    }
  }
  const inline = dom(<DefinitionList items={ITEMS} />).querySelector('dl')
  const track = classes(inline).find((c) => c.includes('grid-cols-'))
  expect(track).toContain('minmax(0,1fr)')
  expect(track).not.toMatch(/_1fr\]/)
})

// --- PageHeader ---

test('PageHeader renders the eyebrow above the title when given', () => {
  const el = dom(<PageHeader eyebrow="Project" title="agentoo" description="Sessions and tabs" />)
  const heading = el.querySelector('h1')
  expect(heading?.textContent).toBe('agentoo')
  const eyebrow = heading?.previousElementSibling
  expect(eyebrow?.tagName).toBe('P')
  expect(eyebrow?.textContent).toBe('Project')
  expect(heading?.nextElementSibling?.textContent).toBe('Sessions and tabs')
})

test('PageHeader omits the eyebrow element entirely when none is given', () => {
  const el = dom(<PageHeader title="agentoo" />)
  const heading = el.querySelector('h1')
  expect(heading?.textContent).toBe('agentoo')
  // Nothing before the heading and nothing after it: no empty placeholder
  // <p> for the missing eyebrow (or the missing description).
  expect(heading?.previousElementSibling?.outerHTML ?? null).toBeNull()
  expect(heading?.nextElementSibling?.outerHTML ?? null).toBeNull()
  expect(el.querySelectorAll('p')).toHaveLength(0)
})

test('PageHeader renders h1 by default and the tag `level` names otherwise — one heading either way', () => {
  const tagsFor = (level?: 1 | 2 | 3) =>
    [...dom(<PageHeader title="T" level={level} />).querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
      (h) => h.tagName,
    )
  expect(tagsFor()).toEqual(['H1'])
  expect(tagsFor(1)).toEqual(['H1'])
  expect(tagsFor(2)).toEqual(['H2'])
  expect(tagsFor(3)).toEqual(['H3'])
})

test('PageHeader renders actions beside the heading block only when given', () => {
  const withActions = dom(<PageHeader title="T" actions={<button type="button">New</button>} />)
  expect(withActions.querySelector('button')?.textContent).toBe('New')
  // The button is not inside the heading block.
  expect(
    withActions.querySelector('h1')?.parentElement?.contains(withActions.querySelector('button')),
  ).toBe(false)

  const without = dom(<PageHeader title="T" />)
  // Just the heading block: no empty actions wrapper.
  expect(without.firstElementChild?.children).toHaveLength(1)
})
