import { useEffect } from 'react'

const PROPERTY = '--shell-height'

/**
 * Publishes `--shell-height` on `<html>` from `window.visualViewport`, because
 * `100dvh` does not shrink for the iOS on-screen keyboard: the keyboard
 * resizes the *visual* viewport, and `dvh` is computed from the *layout* one,
 * which never changes. Without this, a bottom-docked composer sits wherever
 * `100dvh` last measured, which is behind the keyboard.
 *
 * Unset (not just left at its last value) whenever the visual viewport is
 * back to the full layout height, so desktop, Android, and this same iOS
 * device with the keyboard closed all fall through to the `100dvh` default
 * the stylesheet already has.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement

    const update = () => {
      const shrunk = viewport.height < window.innerHeight
      if (shrunk) {
        root.style.setProperty(PROPERTY, `${viewport.height}px`)
      } else {
        root.style.removeProperty(PROPERTY)
      }
    }

    update()
    // `resize` fires as the keyboard opens/closes; `scroll` covers the visual
    // viewport panning while zoomed, which also moves `viewport.height`'s
    // relationship to the page in ways worth re-measuring.
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty(PROPERTY)
    }
  }, [])
}
