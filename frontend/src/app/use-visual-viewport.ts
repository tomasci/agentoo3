import { useEffect } from 'react'

const PROPERTY = '--shell-height'

// Android's URL bar is roughly 56-90px; every phone keyboard in portrait is
// at least ~200px. 150 sits between the two so a URL-bar-only shrink is never
// mistaken for a keyboard.
const KEYBOARD_THRESHOLD_PX = 150

// A `resize` fires at every step of a pinch, and `visualViewport.height`
// shrinks with it (`layoutHeight / scale`) even though nothing about the
// keyboard changed — 1.01 rather than exactly 1 only to absorb rounding.
const MAX_SCALE = 1.01

/**
 * Publishes `--shell-height` on `<html>` from `window.visualViewport`, because
 * `100dvh` does not shrink for the iOS on-screen keyboard: the keyboard
 * resizes the *visual* viewport, and `dvh` is computed from the *layout* one,
 * which never changes. Without this, a bottom-docked composer sits wherever
 * `100dvh` last measured, which is behind the keyboard.
 *
 * Publishing is gated on three things actually meaning "a keyboard is open",
 * because the naive `viewport.height < window.innerHeight` test that used to
 * live here carries no such information:
 *
 * 1. `viewport.scale <= 1.01` — never publish while pinch-zoomed. Zoomed in,
 *    `visualViewport.height` is smaller than the layout height purely from
 *    the zoom (`layoutHeight / scale`), so a 2x pinch would report half the
 *    real height and shrink the whole shell to match — and `resize` fires at
 *    every step of the gesture, so this would thrash the whole way through it.
 * 2. `window.innerHeight - viewport.height >= 150` — a keyboard, not browser
 *    chrome. On Android, `window.innerHeight` is the layout viewport pinned to
 *    the URL-bar-hidden maximum, so without this floor `shrunk` would be
 *    permanently true with no keyboard open at all; the URL bar itself is
 *    ~56-90px, well under every phone keyboard's ~200px+ in portrait.
 * 3. The rounded value differs from the last one published by at least 1px —
 *    otherwise a burst of events with no real change keeps writing the same
 *    style.
 *
 * Events: `resize` only, coalesced into a single `requestAnimationFrame` so a
 * burst produces one style write rather than one per event. The old `scroll`
 * listener existed to track the visual viewport panning while zoomed — which
 * condition 1 above now explicitly refuses to serve, so tracking it here would
 * be pointless: nothing pinch-zoomed ever reaches a publish.
 *
 * No focus-based gate either: focus legitimately lands on the Send button
 * with the keyboard still open on Android, and removing the property at that
 * point would drop the shell behind the keyboard at the worst possible
 * moment.
 *
 * Unset (not just left at its last value) whenever none of the above hold, so
 * desktop, Android, and this same iOS device with the keyboard closed all fall
 * through to the `100dvh` default the stylesheet already has.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    let published: number | null = null
    let frame: number | null = null

    const apply = () => {
      frame = null
      const shrunk =
        viewport.scale <= MAX_SCALE && window.innerHeight - viewport.height >= KEYBOARD_THRESHOLD_PX
      if (!shrunk) {
        published = null
        root.style.removeProperty(PROPERTY)
        return
      }
      const next = Math.round(viewport.height)
      if (published !== null && Math.abs(next - published) < 1) return
      published = next
      root.style.setProperty(PROPERTY, `${next}px`)
    }

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(apply)
    }

    schedule()
    viewport.addEventListener('resize', schedule)
    return () => {
      viewport.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
      root.style.removeProperty(PROPERTY)
    }
  }, [])
}
