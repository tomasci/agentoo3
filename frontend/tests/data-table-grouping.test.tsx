// shared/components/data-table.tsx — the opt-in `groupBy` prop:
//
//   - without it, the body is what it always was: one <tbody>, one <tr> per
//     row, no group heading, and the `empty` cell (one <td colSpan=N>) when
//     there are no rows;
//   - with it, each run of rows sharing a key is its own <tbody>, headed by
//     one row holding a single <th scope="rowgroup" colSpan=N> with the
//     group's label, in the order the rows arrive (it never reorders);
//   - with it and no rows, the empty state is the same single body.
//
// Rendered to static markup and parsed back into happy-dom, the way
// tests/shared-components.test.tsx's own DataTable cases read structure.
// Assertions compare primitives, never DOM nodes.

import { expect, test } from 'bun:test'
import {
  type ColumnDef,
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DataTable } from '@/shared/components'

interface Row {
  id: string
  name: string
  kind: string
}

const columnHelper = createColumnHelper<Row>()
const columns = [
  columnHelper.accessor('name', { header: () => 'Name', meta: { role: 'primary' } }),
  columnHelper.accessor('kind', { header: () => 'Kind', meta: { role: 'meta' } }),
  columnHelper.display({
    id: 'actions',
    header: () => '',
    meta: { role: 'actions' },
    cell: () => <button type="button">Open</button>,
  }),
] as ColumnDef<Row, unknown>[]
const COLUMN_COUNT = 3

function TestTable({
  data,
  empty,
  groupBy,
}: {
  data: Row[]
  empty?: ReactNode
  groupBy?: (row: Row) => { key: string; label: ReactNode }
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} empty={empty} groupBy={groupBy} />
}

function dom(ui: ReactNode): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(ui)
  return el
}

const ROWS: Row[] = [
  { id: '1', name: 'alpha', kind: 'fruit' },
  { id: '2', name: 'bravo', kind: 'fruit' },
  { id: '3', name: 'charlie', kind: 'veg' },
  { id: '4', name: 'delta', kind: 'grain' },
  { id: '5', name: 'echo', kind: 'grain' },
]

const byKind = (row: Row) => ({ key: row.kind, label: `Kind: ${row.kind}` })

/** Each <tbody>, as [heading label or null, [names of its data rows]]. */
const bodies = (el: HTMLElement) =>
  [...el.querySelectorAll('tbody')].map((tbody) => {
    const heading = tbody.querySelector('th')
    const names = [...tbody.querySelectorAll('tr')]
      .filter((tr) => tr.querySelector('td'))
      .map((tr) => tr.querySelector('td')?.textContent ?? '')
    return [heading ? heading.textContent : null, names]
  })

// --- without groupBy: unchanged ---------------------------------------------

test('without groupBy: one tbody, one row per item, no heading cell anywhere in the body', () => {
  const el = dom(<TestTable data={ROWS} />)
  expect(el.querySelectorAll('tbody').length).toBe(1)
  expect(el.querySelectorAll('tbody th').length).toBe(0)
  expect(el.querySelectorAll('[scope="rowgroup"]').length).toBe(0)
  const trs = [...el.querySelectorAll('tbody tr')]
  expect(trs.length).toBe(ROWS.length)
  expect(trs.map((tr) => tr.querySelectorAll('td').length)).toEqual(ROWS.map(() => COLUMN_COUNT))
  expect(bodies(el)).toEqual([[null, ['alpha', 'bravo', 'charlie', 'delta', 'echo']]])
})

test('without groupBy: the header row is the column headers and nothing else', () => {
  const el = dom(<TestTable data={ROWS} />)
  expect([...el.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
    'Name',
    'Kind',
    '',
  ])
})

test('without groupBy and no rows: the empty cell spans every column in the single body', () => {
  const el = dom(<TestTable data={[]} empty="Nothing here" />)
  expect(el.querySelectorAll('tbody').length).toBe(1)
  const tds = [...el.querySelectorAll('tbody td')]
  expect(tds.length).toBe(1)
  expect(tds[0]?.textContent).toBe('Nothing here')
  expect(tds[0]?.getAttribute('colspan')).toBe(String(COLUMN_COUNT))
  expect(el.querySelectorAll('tbody th').length).toBe(0)
})

test('without groupBy, no rows and no `empty`: one tbody with no rows', () => {
  const el = dom(<TestTable data={[]} />)
  expect(el.querySelectorAll('tbody').length).toBe(1)
  expect(el.querySelectorAll('tbody tr').length).toBe(0)
})

// --- with groupBy -----------------------------------------------------------

test('with groupBy: a tbody per run of equal keys, each headed by its label', () => {
  const el = dom(<TestTable data={ROWS} groupBy={byKind} />)
  expect(bodies(el)).toEqual([
    ['Kind: fruit', ['alpha', 'bravo']],
    ['Kind: veg', ['charlie']],
    ['Kind: grain', ['delta', 'echo']],
  ])
})

test('with groupBy: each heading is one th[scope=rowgroup] spanning every column, first in its tbody', () => {
  const el = dom(<TestTable data={ROWS} groupBy={byKind} />)
  const tbodies = [...el.querySelectorAll('tbody')]
  expect(tbodies.length).toBe(3)
  for (const tbody of tbodies) {
    const first = tbody.querySelector('tr')
    const cells = [...(first?.children ?? [])]
    expect(cells.map((c) => c.tagName)).toEqual(['TH'])
    expect(cells[0]?.getAttribute('scope')).toBe('rowgroup')
    expect(cells[0]?.getAttribute('colspan')).toBe(String(COLUMN_COUNT))
    // Exactly one heading per body.
    expect(tbody.querySelectorAll('th').length).toBe(1)
  }
  // The column header row is untouched by grouping.
  expect(el.querySelectorAll('thead th').length).toBe(COLUMN_COUNT)
  expect(el.querySelectorAll('thead [scope="rowgroup"]').length).toBe(0)
})

test('with groupBy: data rows keep every cell', () => {
  const el = dom(<TestTable data={ROWS} groupBy={byKind} />)
  const dataRows = [...el.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td'))
  expect(dataRows.length).toBe(ROWS.length)
  for (const tr of dataRows) expect(tr.querySelectorAll('td').length).toBe(COLUMN_COUNT)
})

test('with groupBy: it never reorders — a key that comes back later starts a new group', () => {
  const data: Row[] = [
    { id: '1', name: 'a', kind: 'x' },
    { id: '2', name: 'b', kind: 'y' },
    { id: '3', name: 'c', kind: 'x' },
  ]
  const el = dom(<TestTable data={data} groupBy={(r) => ({ key: r.kind, label: r.kind })} />)
  expect(bodies(el)).toEqual([
    ['x', ['a']],
    ['y', ['b']],
    ['x', ['c']],
  ])
})

test('with groupBy: the label can be any ReactNode', () => {
  const el = dom(
    <TestTable
      data={ROWS.slice(0, 1)}
      groupBy={() => ({ key: 'k', label: <em data-testid="lbl">fancy</em> })}
    />,
  )
  expect(el.querySelector('th[scope="rowgroup"] em')?.textContent).toBe('fancy')
})

test('with groupBy and no rows: the same single-body empty state, no heading', () => {
  const el = dom(<TestTable data={[]} empty="Nothing here" groupBy={byKind} />)
  expect(el.querySelectorAll('tbody').length).toBe(1)
  expect(el.querySelectorAll('[scope="rowgroup"]').length).toBe(0)
  const tds = [...el.querySelectorAll('tbody td')]
  expect(tds.map((td) => [td.textContent, td.getAttribute('colspan')])).toEqual([
    ['Nothing here', String(COLUMN_COUNT)],
  ])
})
