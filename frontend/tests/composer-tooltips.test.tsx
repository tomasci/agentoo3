// The composer's icon-only controls — attach, stop, send — each wrapped in a
// Base UI Tooltip (components/composer.tsx):
//
//   T1  focusing or hovering a control opens a tooltip with its own key;
//   T2  the wrapped control still does its job (attach clicks the hidden file
//       input, stop calls onStop, send calls onSubmit) and a disabled one
//       still does nothing;
//   T3  the wrapped control keeps `data-slot="button"`, which
//       `TooltipTrigger`'s own `data-slot="tooltip-trigger"` would otherwise
//       overwrite.
//
// How Base UI tooltips open under happy-dom, found by probing before this was
// written: focus opens one immediately, with no provider; hover opens one
// only after the Root's own default delay (~600ms) unless a
// `TooltipProvider` sets it, which the app does (app/providers.tsx, delay 0).
// So focus is tested bare, the way the other composer tests mount it, and
// hover under the same provider the app uses. Both inside act(): opening is a
// state update.
//
// cimode i18n, so every label and tooltip is its bare key. The tooltip
// portals to <body>, so it is looked up document-wide.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import i18next from 'i18next'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { Composer } from '../src/features/sessions/components/composer'
import { TooltipProvider } from '../src/shared/ui/tooltip'

const cimode = i18next.createInstance()
await cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

type ComposerProps = Parameters<typeof Composer>[0]

let calls: { onSubmit: number; onStop: number; onChange: string[]; onModeChange: ('visual' | 'raw')[] }

const props = (o: Partial<ComposerProps> = {}): ComposerProps => ({
  sessionId: 's1',
  value: '',
  onChange: (v) => calls.onChange.push(v),
  onSubmit: () => {
    calls.onSubmit++
  },
  onStop: () => {
    calls.onStop++
  },
  mode: 'raw',
  onModeChange: (m) => calls.onModeChange.push(m),
  sending: false,
  canSend: true,
  queueLine: '',
  error: null,
  attachments: {
    uploads: [],
    usage: undefined,
    usagePending: false,
    usageError: null,
    pendingCount: 0,
    onAttach: () => {},
    onCancel: () => {},
    onRemove: () => {},
  },
  ...o,
})

let container: HTMLDivElement
let root: Root | undefined

function mount(p: ComposerProps, wrap: (n: ReactNode) => ReactNode = (n) => n) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(<I18nextProvider i18n={cimode}>{wrap(<Composer {...p} />)}</I18nextProvider>)
  })
}
const withProvider = (n: ReactNode) => <TooltipProvider>{n}</TooltipProvider>

beforeEach(() => {
  calls = { onSubmit: 0, onStop: 0, onChange: [], onModeChange: [] }
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

const ATTACH = 'sessions.attachments.attach'
const SEND = 'sessions.send'
const STOP = 'sessions.stop'
const TOGGLE = 'sessions.composerMode.source'

const byLabel = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (found.length !== 1) throw new Error(`expected one "${label}" button, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
/** Every open tooltip's text, document-wide (they portal to <body>). */
const openTooltips = () =>
  [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => el.textContent ?? '')

async function focus(el: HTMLElement) {
  await act(async () => {
    el.focus()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function blur(el: HTMLElement) {
  await act(async () => {
    el.blur()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
/** A real pointer's arrival, in the order a browser fires it. */
async function hover(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    el.dispatchEvent(new PointerEvent('pointerenter'))
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseenter'))
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

const CONTROLS = [
  { what: 'attach', label: ATTACH, tip: 'sessions.attachments.attachTooltip', p: {} },
  { what: 'send', label: SEND, tip: 'sessions.sendTooltip', p: { value: 'hello' } },
  { what: 'stop', label: STOP, tip: 'sessions.stopTooltip', p: { canStop: true } },
  // `props()` defaults to raw mode, so the tooltip offers to go back to
  // formatted view — the opposite of what it would say in visual mode.
  { what: 'toggle', label: TOGGLE, tip: 'sessions.composerMode.showFormatted', p: {} },
] as const

// --- T1 ---------------------------------------------------------------------

test('no tooltip is open before anything is focused or hovered', () => {
  mount(props({ value: 'hello', canStop: true }))
  expect(openTooltips()).toEqual([])
})

for (const { what, label, tip, p } of CONTROLS) {
  test(`focusing ${what} opens exactly its tooltip, ${tip}; blurring closes it`, async () => {
    mount(props(p))
    const button = byLabel(label)
    await focus(button)
    expect(openTooltips()).toEqual([tip])
    await blur(button)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
    // Closed: either unmounted, or still animating out with data-closed.
    const stillOpen = [...document.querySelectorAll('[data-slot="tooltip-content"][data-open]')]
    expect(stillOpen.length).toBe(0)
  })

  test(`hovering ${what} under the app's TooltipProvider opens ${tip}`, async () => {
    mount(props(p), withProvider)
    await hover(byLabel(label))
    expect(openTooltips()).toEqual([tip])
  })
}

test('the tooltip text is not the accessible name: each button keeps its own aria-label', () => {
  mount(props({ value: 'hello', canStop: true }))
  expect(byLabel(ATTACH).getAttribute('aria-label')).toBe(ATTACH)
  expect(byLabel(SEND).getAttribute('aria-label')).toBe(SEND)
  expect(byLabel(STOP).getAttribute('aria-label')).toBe(STOP)
})

test('while sending, the send button is labelled sessions.sending and still has the send tooltip', async () => {
  mount(props({ value: 'hello', sending: true, canSend: true }))
  await focus(byLabel('sessions.sending'))
  expect(openTooltips()).toEqual(['sessions.sendTooltip'])
})

// --- T2 ---------------------------------------------------------------------

test('attach still clicks the hidden file input, once', async () => {
  mount(props())
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  let clicks = 0
  input.click = () => {
    clicks++
  }
  await act(async () => {
    byLabel(ATTACH).click()
  })
  expect(clicks).toBe(1)
})

test('send still calls onSubmit once, and never onStop', async () => {
  mount(props({ value: 'hello', canStop: true }))
  await act(async () => {
    byLabel(SEND).click()
  })
  expect(calls.onSubmit).toBe(1)
  expect(calls.onStop).toBe(0)
})

test('stop still calls onStop once, and never onSubmit', async () => {
  mount(props({ value: 'hello', canStop: true }))
  await act(async () => {
    byLabel(STOP).click()
  })
  expect(calls.onStop).toBe(1)
  expect(calls.onSubmit).toBe(0)
})

test('a disabled send is natively disabled and a click does nothing', async () => {
  mount(props({ value: 'hello', canSend: false }))
  const send = byLabel(SEND)
  expect(send.disabled).toBe(true)
  expect(send.hasAttribute('disabled')).toBe(true)
  await act(async () => {
    send.click()
  })
  expect(calls.onSubmit).toBe(0)
})

test('a stopping stop is natively disabled and a click does nothing', async () => {
  mount(props({ canStop: true, stopping: true }))
  const stop = byLabel(STOP)
  expect(stop.disabled).toBe(true)
  await act(async () => {
    stop.click()
  })
  expect(calls.onStop).toBe(0)
})

test('none of the three is a submit button', () => {
  mount(props({ value: 'hello', canStop: true }))
  for (const label of [ATTACH, SEND, STOP]) {
    expect(byLabel(label).getAttribute('type')).toBe('button')
  }
})

test('clicking the toggle calls onModeChange with the other mode, and never onSubmit/onStop', async () => {
  mount(props({ value: 'hello', canStop: true }))
  await act(async () => {
    byLabel(TOGGLE).click()
  })
  expect(calls.onModeChange).toEqual(['visual'])
  expect(calls.onSubmit).toBe(0)
  expect(calls.onStop).toBe(0)
})

// --- T3 ---------------------------------------------------------------------

test('attach, send and stop each keep data-slot="button", not the tooltip trigger\'s slot', () => {
  mount(props({ value: 'hello', canStop: true }))
  for (const label of [ATTACH, SEND, STOP]) {
    expect(byLabel(label).getAttribute('data-slot')).toBe('button')
  }
  expect(container.querySelectorAll('[data-slot="tooltip-trigger"]').length).toBe(0)
})

test('the toggle keeps data-slot="toggle", not the tooltip trigger\'s slot', () => {
  mount(props({ value: 'hello', canStop: true }))
  expect(byLabel(TOGGLE).getAttribute('data-slot')).toBe('toggle')
})
