// `--shell-height`: the one thing in this change that a DOM without layout can
// still judge honestly.
//
// The hook is a pure function of three numbers it reads off `window` —
// `visualViewport.height`, `visualViewport.scale`, `window.innerHeight` — plus
// one event and one animation frame. happy-dom ships none of those numbers
// (`window.visualViewport` is `undefined` here), which is the point: a stand-in
// can supply exactly the pairs a real phone produces, including the two the
// previous implementation got wrong and no laptop ever reproduces.
//
// No CSS-module identity plugin in this file, unlike the component tests:
// `use-visual-viewport.ts` imports React and nothing else, so nothing in the
// graph resolves a `.module.scss`.
//
// What is NOT proved here: that `--shell-height` on `<html>` actually moves the
// composer, that a real iOS keyboard produces the height this asserts on, or
// that Android's `innerHeight` really is pinned to the URL-bar-hidden maximum.
// Those are device facts; this file pins the arithmetic the hook does with
// them.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useVisualViewport } from '../src/app/use-visual-viewport'

const PROPERTY = '--shell-height'

// --- the stand-in viewport ----------------------------------------------------

/** `window.visualViewport`, reduced to what the hook actually touches, plus a
 *  record of which events were subscribed to — the removal of the `scroll`
 *  listener is part of the claim, and an absence is only observable if
 *  subscriptions are recorded. */
class FakeViewport extends EventTarget {
  height = 800
  scale = 1
  readonly added: Array<{ type: string; fn: EventListenerOrEventListenerObject | null }> = []
  readonly removed: Array<{ type: string; fn: EventListenerOrEventListenerObject | null }> = []

  override addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
    this.added.push({ type, fn })
    super.addEventListener(type, fn)
  }

  override removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
    this.removed.push({ type, fn })
    super.removeEventListener(type, fn)
  }

  /** One step of a gesture: the browser mutates the numbers, *then* fires. */
  resize(next: { height?: number; scale?: number }) {
    if (next.height !== undefined) this.height = next.height
    if (next.scale !== undefined) this.scale = next.scale
    this.dispatchEvent(new Event('resize'))
  }
}

let viewport: FakeViewport

// --- a frame clock the test drives -------------------------------------------

const pending = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let realRaf: typeof globalThis.requestAnimationFrame
let realCancel: typeof globalThis.cancelAnimationFrame

/** Runs whatever is queued now. A callback that queues another frame does not
 *  get run by this call — coalescing is counted in frames, so a frame must
 *  mean exactly one turn. */
const flushFrame = () => {
  const queued = [...pending.entries()]
  pending.clear()
  for (const [, cb] of queued) cb(0)
}

// --- what the hook wrote ------------------------------------------------------

type Write = { op: 'set'; value: string } | { op: 'remove' }
let writes: Write[] = []

const root = () => document.documentElement
const shellHeight = () => root().style.getPropertyValue(PROPERTY)

/** Only the publishes. Every frame that decides "no keyboard" also calls
 *  `removeProperty`, whether or not anything was ever set — see the note on
 *  the Android test — so a bare `writes` is the wrong thing to assert "never
 *  published" against. */
const publishes = () => writes.filter((w): w is { op: 'set'; value: string } => w.op === 'set')

// --- mounting -----------------------------------------------------------------

function Probe() {
  useVisualViewport()
  return null
}

let mounted: Root | null = null

async function mount() {
  const container = document.createElement('div')
  document.body.append(container)
  const r = createRoot(container)
  mounted = r
  await act(async () => {
    r.render(<Probe />)
  })
}

async function unmount() {
  const r = mounted
  mounted = null
  if (!r) return
  await act(async () => {
    r.unmount()
  })
}

/** Dispatches on the fake viewport from inside `act`, so any React work a
 *  listener happens to trigger is flushed before the assertion reads. */
async function resize(next: { height?: number; scale?: number }) {
  await act(async () => {
    viewport.resize(next)
  })
}

beforeEach(() => {
  viewport = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  window.innerHeight = 800

  pending.clear()
  nextFrameId = 1
  realRaf = globalThis.requestAnimationFrame
  realCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextFrameId++
    pending.set(id, cb)
    return id
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    pending.delete(id)
  }) as typeof globalThis.cancelAnimationFrame

  writes = []
  const style = root().style
  const set = style.setProperty.bind(style)
  const remove = style.removeProperty.bind(style)
  style.setProperty = (property: string, value: string | null) => {
    if (property === PROPERTY) writes.push({ op: 'set', value: value ?? '' })
    set(property, value)
  }
  style.removeProperty = (property: string) => {
    if (property === PROPERTY) writes.push({ op: 'remove' })
    return remove(property)
  }
})

afterEach(async () => {
  await unmount()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancel
  const style = root().style
  delete (style as { setProperty?: unknown }).setProperty
  delete (style as { removeProperty?: unknown }).removeProperty
  style.removeProperty(PROPERTY)
  Reflect.deleteProperty(window, 'visualViewport')
})

// --- the case the hook exists for ---------------------------------------------

test('an open keyboard publishes the visual viewport height, rounded, in px', async () => {
  viewport.height = 420.4
  await mount()
  // Nothing yet: the mount reading is scheduled, not written inline.
  expect(shellHeight()).toBe('')
  flushFrame()
  expect(shellHeight()).toBe('420px')
  expect(writes).toEqual([{ op: 'set', value: '420px' }])
})

test('a keyboard that opens after mount publishes on the resize', async () => {
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('')

  await resize({ height: 380 })
  flushFrame()
  expect(shellHeight()).toBe('380px')
})

test('closing the keyboard removes the property rather than freezing the last value', async () => {
  viewport.height = 380
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('380px')

  await resize({ height: 800 })
  flushFrame()
  // Removed, not set to 800px: the stylesheet's `var(--shell-height, 100dvh)`
  // fallback is the correct answer with no keyboard, and a published 800px
  // would freeze the shell at whatever the last measurement happened to be.
  expect(shellHeight()).toBe('')
  expect(writes).toEqual([{ op: 'set', value: '380px' }, { op: 'remove' }])
})

// --- the two the old implementation got wrong ---------------------------------

test('Android steady state — a URL-bar-sized gap, no keyboard — never publishes', async () => {
  // `window.innerHeight` is the layout viewport pinned to the URL-bar-hidden
  // maximum, so `viewport.height < window.innerHeight` is permanently true on
  // Android with nothing focused. 70px here; the bar is ~56-90px.
  viewport.height = 730
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('')

  // And it stays quiet as the bar slides, which fires a resize each time.
  for (const height of [744, 760, 712, 730]) {
    await resize({ height })
    flushFrame()
    expect(shellHeight()).toBe('')
  }
  // Nothing was ever published. (`writes` is not empty: a no-keyboard frame
  // calls `removeProperty` unconditionally, even with nothing set — five
  // frames, five removals of an absent property. Harmless, and pinned below
  // as one write per frame rather than one per event.)
  expect(publishes()).toEqual([])
  expect(writes).toEqual([
    { op: 'remove' },
    { op: 'remove' },
    { op: 'remove' },
    { op: 'remove' },
    { op: 'remove' },
  ])
})

test('a pinch-zoom never publishes, at any step of the gesture', async () => {
  await mount()
  flushFrame()

  // `visualViewport.height` is `layoutHeight / scale` while zoomed, so every
  // one of these is a >150px "shrink" with no keyboard anywhere.
  for (const scale of [1.2, 1.5, 2, 3, 1.5, 1]) {
    await resize({ scale, height: 800 / scale })
    flushFrame()
    expect({ scale, published: shellHeight() }).toEqual({ scale, published: '' })
  }
  expect(publishes()).toEqual([])
})

test('pinching while the keyboard is open withdraws the property (current behaviour)', async () => {
  viewport.height = 400
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('400px')

  // Pinch on top of the open keyboard: the height reported now mixes zoom with
  // the keyboard and cannot be told apart, so the hook stands down and the
  // shell falls back to 100dvh until the zoom is released. Pinned as the
  // deliberate choice it is, not as a good outcome.
  await resize({ scale: 2, height: 200 })
  flushFrame()
  expect(shellHeight()).toBe('')

  await resize({ scale: 1, height: 400 })
  flushFrame()
  expect(shellHeight()).toBe('400px')
})

// --- the thresholds, pinned so a change to either constant is visible ---------

test('the keyboard threshold is exactly 150px of shrink', async () => {
  viewport.height = 651 // 149 short — not a keyboard
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('')

  await resize({ height: 650 }) // exactly 150 — a keyboard
  flushFrame()
  expect(shellHeight()).toBe('650px')
})

test('a 140px shrink in landscape is treated as not-a-keyboard', async () => {
  // The threshold's deliberate blind spot: a landscape keyboard on a short
  // viewport can be under 150px tall, and this is what the hook does about it
  // today — nothing. Asserted so that moving the constant shows up here rather
  // than in a bug report.
  window.innerHeight = 400
  viewport.height = 260
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('')
  expect(publishes()).toEqual([])
})

test('the scale gate allows 1.01 and refuses 1.02', async () => {
  viewport.scale = 1.01
  viewport.height = 400
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('400px')

  await resize({ scale: 1.02 })
  flushFrame()
  expect(shellHeight()).toBe('')
})

// --- coalescing and de-duplication --------------------------------------------

test('a burst of resizes inside one frame produces exactly one style write', async () => {
  await mount()
  flushFrame()
  const before = writes.length

  for (const height of [700, 600, 500, 420, 400]) {
    await act(async () => {
      viewport.resize({ height })
    })
  }
  // One frame requested for the whole burst, not five.
  expect(pending.size).toBe(1)

  flushFrame()
  // The last state wins; the four intermediate heights are never written, and
  // the whole burst costs one write rather than five.
  expect(writes.slice(before)).toEqual([{ op: 'set', value: '400px' }])
  expect(shellHeight()).toBe('400px')
})

test('a frame whose rounded height matches the last published one writes nothing', async () => {
  viewport.height = 400.2
  await mount()
  flushFrame()
  expect(writes).toEqual([{ op: 'set', value: '400px' }])

  await resize({ height: 400.4 }) // still 400 once rounded
  flushFrame()
  expect(writes).toEqual([{ op: 'set', value: '400px' }])


  await resize({ height: 400.6 }) // 401 — a real change
  flushFrame()
  expect(writes).toEqual([{ op: 'set', value: '400px' }, { op: 'set', value: '401px' }])
})

test('re-opening the keyboard at the same height still publishes after a close', async () => {
  // The de-duplication is per publishing run, not for the life of the hook:
  // the close removes the property, so the identical height afterwards has to
  // be written again or the shell stays at 100dvh with a keyboard over it.
  viewport.height = 400
  await mount()
  flushFrame()
  await resize({ height: 800 })
  flushFrame()
  await resize({ height: 400 })
  flushFrame()

  expect(writes).toEqual([
    { op: 'set', value: '400px' },
    { op: 'remove' },
    { op: 'set', value: '400px' },
  ])
  expect(shellHeight()).toBe('400px')
})

// --- subscriptions -------------------------------------------------------------

test('only `resize` is subscribed to — the `scroll` listener is gone', async () => {
  await mount()
  expect(viewport.added.map((l) => l.type)).toEqual(['resize'])
})

test('unmount removes the listener it added, cancels a pending frame, and clears the property', async () => {
  viewport.height = 400
  await mount()
  flushFrame()
  expect(shellHeight()).toBe('400px')

  // A frame in flight at teardown: the callback closes over the removed
  // property and would re-publish it after the component is gone.
  await resize({ height: 380 })
  expect(pending.size).toBe(1)

  await unmount()
  expect(pending.size).toBe(0)
  expect(shellHeight()).toBe('')

  // The same function object, not merely something of the same type.
  expect(viewport.removed.map((l) => l.type)).toEqual(['resize'])
  expect(viewport.removed[0]?.fn).toBe(viewport.added[0]?.fn)

  // And nothing left listening: a resize after teardown neither writes nor
  // queues a frame.
  const after = writes.length
  viewport.resize({ height: 300 })
  flushFrame()
  expect(pending.size).toBe(0)
  expect(writes.length).toBe(after)
  expect(shellHeight()).toBe('')
})

test('a browser with no visualViewport is a no-op rather than a crash', async () => {
  Reflect.deleteProperty(window, 'visualViewport')
  await mount()
  expect(pending.size).toBe(0)
  await unmount()
  expect(writes).toEqual([])
  expect(shellHeight()).toBe('')
})
