// CopyButton's "copied" state reverts after ~1.5s via a setTimeout scheduled
// on each successful copy. A second click inside that window must not have
// its own "copied" state cut short by the first click's timer — the timer
// has to be cleared and rescheduled on every copy (and on unmount).
//
// Mounted under a private `cimode` i18next instance, same isolation as
// tests/shared-components.test.tsx and tests/transcript-copy-markdown.test.tsx
// — the accessible name is asserted as the raw key. Never `.use(initReactI18next)`
// on it — see tests/settings-page.test.tsx.

import { afterEach, expect, test } from 'bun:test'
import i18next from 'i18next'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { CopyButton } from '@/shared/components'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(ui: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<I18nextProvider i18n={testI18n}>{ui}</I18nextProvider>)
  })
  return host
}

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function mockWriteText() {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else delete (navigator as { clipboard?: unknown }).clipboard
})

async function click(button: HTMLElement) {
  await act(async () => {
    button.click()
    // writeText's promise, then the state update.
    await Promise.resolve()
    await Promise.resolve()
  })
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

test('a second click inside the 1.5s window is not reset early by the first click\'s timer', async () => {
  mockWriteText()
  const container = await mount(<CopyButton value="x" />)
  const button = container.querySelector('button') as HTMLButtonElement

  await click(button)
  expect(button.textContent).toBe('common.copied')

  // Just before the first click's timer (1.5s) would fire, click again.
  await wait(1000)
  await click(button)
  expect(button.textContent).toBe('common.copied')

  // 900ms after the second click (1900ms after the first): the first
  // click's timer alone would have fired at 1500ms and flipped this back
  // to common.copy already. It must still read common.copied here.
  await wait(900)
  expect(button.textContent).toBe('common.copied')

  // The second click's own timer fires ~1.5s after its click (600ms later).
  await wait(600)
  expect(button.textContent).toBe('common.copy')
})

test('unmounting mid-countdown does not throw from the pending timer', async () => {
  mockWriteText()
  const container = await mount(<CopyButton value="x" />)
  const button = container.querySelector('button') as HTMLButtonElement

  await click(button)
  expect(button.textContent).toBe('common.copied')

  await act(() => root?.unmount())
  root = undefined
  // The cleared timer must not fire a setState on the unmounted component;
  // if it did, happy-dom/React would surface it as an unhandled error here.
  await wait(1600)
})
