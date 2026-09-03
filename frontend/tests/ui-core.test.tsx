import { plugin } from 'bun'
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'

// Bun's own `.module.scss` loader (used by `bun test`, unlike the Vite build)
// resolves the import to the bare file path rather than a class map, so every
// `styles.someClass` read in a component comes back `undefined` and every
// rendered `className` collapses to `""` — real class names are
// indistinguishable from each other under the default loader. That defeats
// the assertions this file needs to make ("Badge applies the tone class",
// "DataTable renders `empty`"), so this registers an identity-proxy loader —
// the same technique `identity-obj-proxy` uses for Jest — scoped by an exact
// path allowlist to only the ten `.module.scss` files this track owns. It
// therefore cannot change how any file outside this track resolves its own
// styles (verified: `core/button.module.scss`, which this track does not
// own, still resolves to `undefined` after this plugin registers).
const OWNED_STYLES =
  /src\/shared\/ui\/(core\/(badge|status-dot|code|layout)|patterns\/(card|page-header|empty-state|alert|definition-list|data-table))\.module\.scss$/

plugin({
  name: 'ui-core-test-css-module-identity',
  setup(build) {
    build.onLoad({ filter: OWNED_STYLES }, () => ({
      contents: 'export default new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) })',
      loader: 'js',
    }))
  },
})

// Dynamic imports, not static ones: static imports are hoisted and would
// resolve `.module.scss` before the `plugin()` call above ever runs.
const { Badge } = await import('../src/shared/ui/core/badge')
const { StatusDot } = await import('../src/shared/ui/core/status-dot')
const { Code } = await import('../src/shared/ui/core/code')
const { Stack, Inline } = await import('../src/shared/ui/core/layout')
const { Card } = await import('../src/shared/ui/patterns/card')
const { PageHeader } = await import('../src/shared/ui/patterns/page-header')
const { EmptyState } = await import('../src/shared/ui/patterns/empty-state')
const { Alert } = await import('../src/shared/ui/patterns/alert')
const { DefinitionList } = await import('../src/shared/ui/patterns/definition-list')
const { DataTable } = await import('../src/shared/ui/patterns/data-table')
const { renderToStaticMarkup } = await import('react-dom/server')
const { createColumnHelper, getCoreRowModel, useReactTable } = await import('@tanstack/react-table')

// --- Badge ---

test('Badge applies the tone class, distinct per tone', () => {
  const danger = renderToStaticMarkup(<Badge tone="danger">Failed</Badge>)
  const success = renderToStaticMarkup(<Badge tone="success">Ready</Badge>)
  expect(danger).toContain('toneDanger')
  expect(success).toContain('toneSuccess')
  expect(danger).not.toContain('toneSuccess')
})

test('Badge defaults to neutral/soft and renders its children', () => {
  const out = renderToStaticMarkup(<Badge>Draft</Badge>)
  expect(out).toContain('toneNeutral')
  expect(out).toContain('variantSoft')
  expect(out).toContain('Draft')
})

// --- StatusDot ---

test('StatusDot is aria-hidden — it is never the sole carrier of meaning', () => {
  const out = renderToStaticMarkup(<StatusDot tone="success" />)
  expect(out).toContain('aria-hidden')
})

test('StatusDot only animates when pulse is set', () => {
  const still = renderToStaticMarkup(<StatusDot tone="warning" />)
  const pulsing = renderToStaticMarkup(<StatusDot tone="warning" pulse />)
  expect(still).not.toContain('pulse')
  expect(pulsing).toContain('pulse')
})

// --- Code ---

test('Code renders inline as a bare <code>, block as <pre><code>', () => {
  const inline = renderToStaticMarkup(<Code>curl</Code>)
  expect(inline).toBe('<code class="inline">curl</code>')

  const block = renderToStaticMarkup(<Code block>{'line one\nline two'}</Code>)
  expect(block).toContain('<pre')
  expect(block).toContain('<code>')
  expect(block).toContain('line one\nline two')
})

test('Code wrap is opt-in', () => {
  const noWrap = renderToStaticMarkup(<Code block>x</Code>)
  const wrapped = renderToStaticMarkup(
    <Code block wrap>
      x
    </Code>,
  )
  expect(noWrap).not.toContain('wrap')
  expect(wrapped).toContain('wrap')
})

// --- Stack / Inline ---

test('Stack stacks children in a gap-3 column by default', () => {
  const out = renderToStaticMarkup(
    <Stack>
      <span>a</span>
      <span>b</span>
    </Stack>
  )
  expect(out).toContain('gap3')
  expect(out).toContain('<span>a</span><span>b</span>')
})

test('Inline accepts an explicit gap and renders its children', () => {
  const out = renderToStaticMarkup(
    <Inline gap={5}>
      <span>a</span>
    </Inline>
  )
  expect(out).toContain('gap5')
})

// --- Card ---

test('Card variants render distinct classes, and `as` picks the tag', () => {
  const solid = renderToStaticMarkup(<Card>content</Card>)
  const dashed = renderToStaticMarkup(<Card variant="dashed">content</Card>)
  expect(solid).toContain('variantSolid')
  expect(dashed).toContain('variantDashed')
  expect(solid.startsWith('<section')).toBe(true)

  const asArticle = renderToStaticMarkup(<Card as="article">content</Card>)
  expect(asArticle.startsWith('<article')).toBe(true)
})

// --- PageHeader ---

test('PageHeader level picks the heading tag, defaulting to h1', () => {
  const h1 = renderToStaticMarkup(<PageHeader title="Projects" />)
  expect(h1).toContain('<h1')
  expect(h1).toContain('Projects')

  const h3 = renderToStaticMarkup(<PageHeader title="Section" level={3} />)
  expect(h3).toContain('<h3')
  expect(h3).not.toContain('<h1')
})

test('PageHeader omits eyebrow and description when not given', () => {
  const bare = renderToStaticMarkup(<PageHeader title="Projects" />)
  expect(bare).not.toContain('eyebrow')

  const full = renderToStaticMarkup(
    <PageHeader title="Projects" eyebrow="Workspace" description="All active projects" />
  )
  expect(full).toContain('Workspace')
  expect(full).toContain('All active projects')
})

// --- EmptyState ---

test('EmptyState renders title, optional description and action', () => {
  const out = renderToStaticMarkup(
    <EmptyState
      title="No projects yet"
      description="Clone or create one to get started."
      action={<button type="button">New project</button>}
    />
  )
  expect(out).toContain('No projects yet')
  expect(out).toContain('Clone or create one to get started.')
  expect(out).toContain('New project')
})

// --- Alert: the highest-value assertion in this file ---

test('Alert tone="danger" (the default) interrupts: role="alert", aria-live="assertive"', () => {
  const explicit = renderToStaticMarkup(<Alert tone="danger">Something failed</Alert>)
  const defaulted = renderToStaticMarkup(<Alert>Something failed</Alert>)
  for (const out of [explicit, defaulted]) {
    expect(out).toContain('role="alert"')
    expect(out).toContain('aria-live="assertive"')
  }
})

test.each(['neutral', 'accent', 'success', 'warning'] as const)(
  'Alert tone="%s" is polite: role="status", aria-live="polite"',
  (tone) => {
    const out = renderToStaticMarkup(<Alert tone={tone}>Note</Alert>)
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
    expect(out).not.toContain('role="alert"')
  }
)

test('Alert composes with Code for the preformatted stderr case', () => {
  const out = renderToStaticMarkup(
    <Alert tone="danger" title="Build failed">
      <Code block wrap>
        {'error: cannot find module'}
      </Code>
    </Alert>
  )
  expect(out).toContain('Build failed')
  expect(out).toContain('<pre')
  expect(out).toContain('error: cannot find module')
})

// --- DefinitionList ---

test('DefinitionList renders one dt/dd pair per item', () => {
  const out = renderToStaticMarkup(
    <DefinitionList
      items={[
        { id: 'a', term: 'Name', description: 'agentoo' },
        { id: 'b', term: 'Status', description: 'ready' },
      ]}
    />
  )
  expect(out).toContain('<dl')
  expect((out.match(/<dt/g) ?? []).length).toBe(2)
  expect((out.match(/<dd/g) ?? []).length).toBe(2)
  expect(out).toContain('Name')
  expect(out).toContain('agentoo')
})

test('DefinitionList layout switches class from inline to stacked', () => {
  const items = [{ id: 'a', term: 'Name', description: 'agentoo' }]
  const inline = renderToStaticMarkup(<DefinitionList items={items} />)
  const stacked = renderToStaticMarkup(<DefinitionList items={items} layout="stacked" />)
  expect(inline).toContain('layoutInline')
  expect(stacked).toContain('layoutStacked')
})

// --- DataTable ---

interface Row {
  id: string
  name: string
}

const columnHelper = createColumnHelper<Row>()
const columns = [
  columnHelper.accessor('name', { header: () => 'Name' }),
  columnHelper.display({ id: 'actions', header: () => '', cell: () => <button type="button">Open</button> }),
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

test('DataTable renders rows and their cells when data is present', () => {
  const out = renderToStaticMarkup(<TestTable data={[{ id: '1', name: 'agentoo' }]} />)
  expect(out).toContain('agentoo')
  expect(out).toContain('Open')
  expect(out).not.toContain('No rows to show')
})

test('DataTable right-aligns and shrinks compactColumns (defaulting to "actions")', () => {
  const out = renderToStaticMarkup(<TestTable data={[{ id: '1', name: 'agentoo' }]} />)
  // The header cell for the "actions" column carries the compact class; the
  // "name" column's header does not.
  const headerCells = out.match(/<th[^>]*>.*?<\/th>/g) ?? []
  expect(headerCells.length).toBe(2)
  expect(headerCells[1]).toContain('compact')
  expect(headerCells[0]).not.toContain('compact')
})
