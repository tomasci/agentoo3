import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
// Real translations, not raw i18next keys: ConfirmDialog and ActionsMenu read
// through react-i18next, and `common.cancel` in the output would be a weaker
// assertion than the actual "Cancel" string a user sees.
import '@/shared/i18n'
import { ActionsMenu } from '../src/shared/ui/overlay/actions-menu'
import { ConfirmDialog } from '../src/shared/ui/overlay/confirm-dialog'
import { Tooltip } from '../src/shared/ui/overlay/tooltip'
import { Collapsible } from '../src/shared/ui/disclosure/collapsible'

// Ark's <Portal> checks `useSyncExternalStore`'s server snapshot and renders
// its children inline (a Fragment) rather than through `ReactDOM.createPortal`
// when there is no real document to portal into — which is exactly the
// `renderToStaticMarkup` case here. So Dialog/Menu/Tooltip content genuinely
// appears in these strings; this is not a vacuous check of markup that never
// mounts. What it can *not* verify is that a real browser actually moves that
// markup to `document.body` — that only exists once client JS runs.

// --- ConfirmDialog ---

test('ConfirmDialog renders its title and description whether open or closed', () => {
  // Ark's Dialog never unmounts its Content on close — it toggles `hidden`
  // and `data-state` instead — so "renders nothing when closed" would be
  // asserting a behaviour this implementation doesn't have.
  for (const open of [true, false]) {
    const out = renderToStaticMarkup(
      <ConfirmDialog
        open={open}
        onOpenChange={() => {}}
        title="Delete project"
        description="Are you sure?"
        onConfirm={() => {}}
      />,
    )
    expect(out).toContain('Delete project')
    expect(out).toContain('Are you sure?')
  }
})

test('ConfirmDialog toggles data-state and the hidden attribute with `open`', () => {
  const closed = renderToStaticMarkup(
    <ConfirmDialog open={false} onOpenChange={() => {}} title="t" description="d" onConfirm={() => {}} />,
  )
  const open = renderToStaticMarkup(
    <ConfirmDialog open onOpenChange={() => {}} title="t" description="d" onConfirm={() => {}} />,
  )
  expect(closed).toContain('data-state="closed"')
  expect(closed).toContain('hidden=""')
  expect(open).toContain('data-state="open"')
  expect(open).not.toContain('hidden=""')
})

test('ConfirmDialog wires alertdialog aria: role, aria-modal, labelledby/describedby', () => {
  const out = renderToStaticMarkup(
    <ConfirmDialog open onOpenChange={() => {}} title="t" description="d" onConfirm={() => {}} />,
  )
  expect(out).toContain('role="alertdialog"')
  expect(out).toContain('aria-modal="true"')
  expect(out).toMatch(/aria-labelledby="[^"]+:title"/)
  expect(out).toMatch(/aria-describedby="[^"]+:description"/)
})

test('ConfirmDialog renders Cancel and a translated confirm label', () => {
  const out = renderToStaticMarkup(
    <ConfirmDialog open onOpenChange={() => {}} title="t" description="d" onConfirm={() => {}} />,
  )
  expect(out).toContain('Cancel')
  // destructive defaults true, and no confirmLabel override, so the default
  // "delete" string is what actually appears — not a placeholder.
  expect(out).toContain('Delete')
})

// --- Collapsible ---

test('Collapsible wires the trigger to its content via aria-controls/id', () => {
  const out = renderToStaticMarkup(
    <Collapsible title="Section">
      <div>Body</div>
    </Collapsible>,
  )
  const controls = out.match(/aria-controls="([^"]+)"/)?.[1]
  expect(controls).toBeTruthy()
  expect(out).toContain(`id="${controls}"`)
})

test('Collapsible aria-expanded and data-state track defaultOpen', () => {
  const closed = renderToStaticMarkup(
    <Collapsible title="Section">
      <div>Body</div>
    </Collapsible>,
  )
  const open = renderToStaticMarkup(
    <Collapsible title="Section" defaultOpen>
      <div>Body</div>
    </Collapsible>,
  )
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).toContain('data-state="closed"')
  expect(open).toContain('aria-expanded="true"')
  expect(open).toContain('data-state="open"')
})

test('Collapsible renders its content text when defaultOpen', () => {
  const out = renderToStaticMarkup(
    <Collapsible title="Section" defaultOpen>
      <div>Body content</div>
    </Collapsible>,
  )
  expect(out).toContain('Body content')
})

// --- ActionsMenu ---

test('ActionsMenu with an empty actions array renders nothing and does not crash', () => {
  expect(() => renderToStaticMarkup(<ActionsMenu actions={[]} />)).not.toThrow()
  expect(renderToStaticMarkup(<ActionsMenu actions={[]} />)).toBe('')
})

test('ActionsMenu renders a labelled trigger and one item per action', () => {
  const out = renderToStaticMarkup(
    <ActionsMenu
      actions={[
        { id: 'edit', label: 'Edit', onSelect: () => {} },
        { id: 'delete', label: 'Delete', onSelect: () => {}, destructive: true },
      ]}
    />,
  )
  expect(out).toContain('aria-haspopup="menu"')
  expect(out).toContain('aria-label="Actions"')
  expect((out.match(/role="menuitem"/g) ?? []).length).toBe(2)
  expect(out).toContain('Edit')
  expect(out).toContain('Delete')
})

test('ActionsMenu marks a disabled action with data-disabled, not just a visual dimming', () => {
  const out = renderToStaticMarkup(
    <ActionsMenu actions={[{ id: 'a', label: 'Locked', onSelect: () => {}, disabled: true }]} />,
  )
  expect(out).toContain('data-disabled')
})

// --- Tooltip ---

test('Tooltip renders its trigger via asChild, adding no wrapper element', () => {
  const out = renderToStaticMarkup(
    <Tooltip content="Copies the ID">
      <button type="button">Copy</button>
    </Tooltip>,
  )
  expect(out.startsWith('<button')).toBe(true)
  expect(out).toContain('Copy')
})

test('Tooltip content renders (closed) alongside the trigger', () => {
  const out = renderToStaticMarkup(
    <Tooltip content="Copies the ID">
      <button type="button">Copy</button>
    </Tooltip>,
  )
  expect(out).toContain('Copies the ID')
  expect(out).toContain('role="tooltip"')
})
