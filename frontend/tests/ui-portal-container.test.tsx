import { afterEach, expect, test } from 'bun:test'
import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// Real translations: Select renders `t('common.noOptions')` for an empty
// option list, and an unbootstrapped i18next throws rather than falling back.
import '@/shared/i18n'
import { Select } from '../src/shared/ui/forms/select'
import { PortalContainerProvider } from '../src/shared/ui/lib/portal-container'
import { Dialog } from '../src/shared/ui/overlay/dialog'
import { Menu } from '../src/shared/ui/overlay/menu'
import { Toaster } from '../src/shared/ui/overlay/toast'
import { Tooltip } from '../src/shared/ui/overlay/tooltip'

// A real client mount (createRoot + act in happy-dom), never
// `renderToStaticMarkup` like ui-overlay/ui-forms: Ark's <Portal> checks
// `useSyncExternalStore`'s server snapshot and short-circuits to a Fragment on
// the server, which makes its `container` prop a no-op — a string-rendering
// test of this fix would pass while proving nothing. Mounting for real is also
// what runs the two effects the fix depends on: Ark's Portal re-reading
// `props.container` (portal.js:12-14, keyed on the ref *object's* identity),
// and @zag-js/dialog's one-rAF `aria-hidden` walk.
//
// What these tests can prove: DOM containment, and the `aria-hidden`
// attribute — both are real DOM facts happy-dom models, and the walk is
// verified to actually run here (see the parked-guard test). What they can
// NOT prove: that the dropdown paints above the modal. happy-dom has no
// layout, no stacking contexts and no compositor, so nothing here is evidence
// about pixels; that containment implies paint order is a CSS argument, made
// in docs/component-contract.md, not something an assertion can carry.
// Deliberately absent: any test reading a computed `z-index` and concluding
// "visible" — happy-dom returns what was set, not what a browser resolves.

const DIALOG_CONTENT = '[data-scope="dialog"][data-part="content"]'
const SELECT_POSITIONER = '[data-scope="select"][data-part="positioner"]'
const MENU_POSITIONER = '[data-scope="menu"][data-part="positioner"]'
const TOOLTIP_POSITIONER = '[data-scope="tooltip"][data-part="positioner"]'
const TOAST_GROUP = '[data-scope="toast"][data-part="group"]'

const OPTIONS = [{ value: 'a', label: 'Alpha' }]
const ITEMS = [{ id: 'one', label: 'One', onSelect: () => {} }]

let root: Root | undefined

/**
 * Every assertion below compares this short label rather than the element
 * itself. Not cosmetic: bun:test serialises whatever a failing `toBe` is
 * handed, and a happy-dom element expands into a tree large enough to hang
 * the runner indefinitely — verified by failing one on purpose. A test whose
 * failure never prints is a test nobody can act on.
 */
const where = (node: Node | null | undefined): string => {
  if (!node) return 'none'
  if (node === document.body) return 'document.body'
  if (!(node instanceof HTMLElement)) return node.nodeName.toLowerCase()
  const scope = node.getAttribute('data-scope')
  const part = node.getAttribute('data-part')
  return scope && part ? `${scope}:${part}` : `<${node.tagName.toLowerCase()}>`
}

/**
 * The two flushes after `render` are deliberate. Ark's Portal mounts on
 * `document.body` in its first render — the container ref's `.current` is
 * still null while rendering — and only re-targets from an effect, once
 * Dialog.Content's ref callback has published a new ref object; the empty
 * `act` covers a commit ordering where that cascade outlives the mounting
 * one. `flushFrame` then settles @zag-js/dialog's deferred work, without
 * which its state updates land after the test body and React warns about
 * updates outside `act`.
 */
async function mount(ui: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(ui)
  })
  await act(async () => {})
  await flushFrame()
}

/**
 * The `aria-hidden` walk is deferred one `requestAnimationFrame`
 * (@zag-js/aria-hidden `index.js:29-40`), so nothing about it is observable
 * until at least one frame after open.
 */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  await act(async () => {})
}

const $ = (selector: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`not mounted: ${selector}`)
  return el
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  // Drained inside `act`, not just unmounted: `bun test` runs every file in
  // one process against one shared `document`, and workspace.test.tsx
  // replaces `console.error` for the remainder of the run and fails on
  // anything it catches. A frame's worth of Zag/React teardown escaping this
  // file would surface as a failure over there, pointing at innocent code.
  await flushFrame()
  // Portals and parked guard nodes are body children, and the aria-hidden
  // walk stamps every body child it finds — leaving one behind would let a
  // previous test's attribute satisfy the next test's guard.
  document.body.replaceChildren()
})

// --- Fallback outside a Dialog is unchanged ---

test('Select outside a Dialog still portals to document.body', async () => {
  await mount(<Select options={OPTIONS} />)
  expect(where($(SELECT_POSITIONER).parentElement)).toBe('document.body')
})

test('Menu outside a Dialog still portals to document.body', async () => {
  await mount(<Menu trigger="⋯" label="Actions" items={ITEMS} />)
  expect(where($(MENU_POSITIONER).parentElement)).toBe('document.body')
})

test('Tooltip outside a Dialog still portals to document.body', async () => {
  await mount(
    <Tooltip content="Tip">
      <button type="button">Trigger</button>
    </Tooltip>,
  )
  expect(where($(TOOLTIP_POSITIONER).parentElement)).toBe('document.body')
})

// --- Inside an open Dialog, the popup is a descendant of Dialog.Content ---

test('Select inside an open Dialog portals into Dialog.Content, not document.body', async () => {
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Select options={OPTIONS} />
    </Dialog>,
  )
  const positioner = $(SELECT_POSITIONER)
  expect($(DIALOG_CONTENT).contains(positioner)).toBe(true)
  expect(where(positioner.parentElement)).not.toBe('document.body')
})

test('Menu inside an open Dialog portals into Dialog.Content, not document.body', async () => {
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Menu trigger="⋯" label="Actions" items={ITEMS} />
    </Dialog>,
  )
  const positioner = $(MENU_POSITIONER)
  expect($(DIALOG_CONTENT).contains(positioner)).toBe(true)
  expect(where(positioner.parentElement)).not.toBe('document.body')
})

test('Tooltip inside an open Dialog portals into Dialog.Content, not document.body', async () => {
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Tooltip content="Tip">
        <button type="button">Trigger</button>
      </Tooltip>
    </Dialog>,
  )
  const positioner = $(TOOLTIP_POSITIONER)
  expect($(DIALOG_CONTENT).contains(positioner)).toBe(true)
  expect(where(positioner.parentElement)).not.toBe('document.body')
})

test('the container is Dialog.Content itself, never Dialog.Positioner', async () => {
  // Positioner would fix paint order and leave the a11y bug untouched: the
  // popup would still be a body-adjacent sibling of Content as far as the
  // aria-hidden walk is concerned (component-contract.md, "Portal containers").
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Select options={OPTIONS} />
    </Dialog>,
  )
  expect(where($(SELECT_POSITIONER).parentElement)).toBe('dialog:content')
})

// --- Controls: the assertions above are not vacuously true ---

test('a container ref that resolves to null falls back to document.body', async () => {
  // The discriminator for every `not.toBe('document.body')` above: same
  // component, same dialog, same selector, container defeated — Ark's Portal
  // must land it back on the body. Without this, "parent is not body" could
  // be passing for a reason unrelated to the container prop.
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <PortalContainerProvider value={{ current: null }}>
        <Select options={OPTIONS} />
      </PortalContainerProvider>
    </Dialog>,
  )
  expect(where($(SELECT_POSITIONER).parentElement)).toBe('document.body')
})

test('the re-target is already complete when the mounting act() returns', async () => {
  // Documents the observed React 19 behaviour rather than a requirement: the
  // mounting `act` drains the ref-callback -> new-ref-object -> Portal-effect
  // cascade, so there is no window in which the popup is observably on the
  // body. If this ever fails, `mount`'s trailing flush is load-bearing after
  // all and the other tests still hold — this one is the canary, not a
  // contract on Ark.
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <Dialog open onOpenChange={() => {}} title="Settings">
        <Select options={OPTIONS} />
      </Dialog>,
    )
  })
  expect(where($(SELECT_POSITIONER).parentElement)).toBe('dialog:content')
  // Settles the dialog's deferred frame so its updates stay inside `act`.
  await flushFrame()
})

// --- Bug 2: the popup is not swept up by the aria-hidden walk ---

test("an open Dialog's aria-hidden walk runs here and does not reach the Select popup", async () => {
  // The parked node is the whole point: `closest('[aria-hidden="true"]')`
  // coming back null passes trivially in an environment where the walk never
  // runs, so a plain body sibling has to come back stamped for the null to
  // mean anything.
  const parked = document.createElement('div')
  parked.textContent = 'outside the dialog'
  document.body.append(parked)

  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Select options={OPTIONS} />
    </Dialog>,
  )

  // `mount` has already flushed the frame the walk defers to.
  expect(parked.getAttribute('aria-hidden')).toBe('true')
  expect(where($(SELECT_POSITIONER).closest('[aria-hidden="true"]'))).toBe('none')
})

test('the same walk does stamp a Select popup left on document.body', async () => {
  // Bug 2 reproduced by defeating only the container: this is the state the
  // fix removes, and it is what makes the assertion above meaningful.
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <PortalContainerProvider value={{ current: null }}>
        <Select options={OPTIONS} />
      </PortalContainerProvider>
    </Dialog>,
  )

  const positioner = $(SELECT_POSITIONER)
  expect(where(positioner.parentElement)).toBe('document.body')
  expect(positioner.getAttribute('aria-hidden')).toBe('true')
})

// --- The flow the bug was actually reported in ---

/** A dialog opened by a state change, not one mounted already open — the
 *  order the app produces, and the order the bug needs: the Select's
 *  positioner is mounted on `document.body` while the dialog is still closed,
 *  and the walk runs later. The second, page-level Select stands in for the
 *  content behind the modal. */
function OpenLater() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Select options={[{ value: 'page', label: 'On the page' }]} />
      <Dialog open={open} onOpenChange={setOpen} title="Settings">
        <Select options={OPTIONS} />
      </Dialog>
    </>
  )
}

test('a Dialog opened after mount still gets its Select inside Content, and only the page-level one is hidden', async () => {
  await mount(<OpenLater />)
  const positioners = () => [...document.querySelectorAll<HTMLElement>(SELECT_POSITIONER)]
  expect(positioners().map((p) => where(p.parentElement))).toEqual([
    'document.body',
    'dialog:content',
  ])

  await act(async () => {
    $('button').click()
  })
  await flushFrame()

  const [onPage, inDialog] = positioners()
  expect(where(onPage?.parentElement)).toBe('document.body')
  expect(where(inDialog?.parentElement)).toBe('dialog:content')
  // The page-level select being hidden is correct — it really is behind the
  // modal — and it is a second, independent witness that the walk ran, so
  // the `none` below is not the absence of a walk.
  expect(where(onPage?.closest('[aria-hidden="true"]'))).toBe('select:positioner')
  expect(where(inDialog?.closest('[aria-hidden="true"]'))).toBe('none')
})

// --- Toaster is the deliberate exception ---

test('Toaster portals to document.body even when rendered inside an open Dialog', async () => {
  // Not a style preference: a toast raised by a dialog action must outlive
  // the dialog, and Dialog.Content unmounts with it. If Toaster ever starts
  // reading usePortalContainer(), this is where it is caught.
  await mount(
    <Dialog open onOpenChange={() => {}} title="Settings">
      <Toaster />
    </Dialog>,
  )
  const group = $(TOAST_GROUP)
  expect(where(group.parentElement)).toBe('document.body')
  expect($(DIALOG_CONTENT).contains(group)).toBe(false)
})
