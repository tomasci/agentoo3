import { useAtomValue } from 'jotai'
import { useLayoutEffect } from 'react'
import { backgroundAtom } from '@/shared/store/ui'
import { HIGHLIGHT_TINT_ALIAS_CLASS_NAME, HIGHLIGHT_TINT_CLASS_NAME } from '../lib/catalog'

/**
 * Tints every hover/selected/open highlight in the app to match a reader's
 * chosen background colour or gradient — see `lib/catalog.ts`'s own comments
 * on `HIGHLIGHT_TINT_CLASS_NAME`/`HIGHLIGHT_TINT_ALIAS_CLASS_NAME` for which
 * tokens that reaches and why. Mounted once, in `root-layout.tsx`'s `Shell`
 * next to `useBackdropActive()` — deliberately *not* in `RootLayout` itself,
 * so a bare-shell route like the editor launcher never carries a body class
 * for a shell it doesn't render.
 *
 * Reads only `backgroundAtom`, not the pattern atom: a pattern drawn over
 * `'none'` leaves the shell's ordinary grey surface untouched, so it leaves
 * every highlight untinted too, same as choosing nothing at all.
 *
 * Classes land on `document.body`, not `document.documentElement`: this
 * project's `dark:` variant is `&:is(.dark *)`, a descendant selector, and
 * `.dark` itself sits on `<html>` — the same element a tint class would
 * land on, not a descendant of it, so every `dark:` rule inside the alias
 * class would never match its own element. `<body>` is a genuine descendant
 * of `<html>`, so the same class there does match, and it is also the one
 * ancestor every portal (a menu, a dialog, the phone sidebar's `Sheet`)
 * actually mounts under — unlike `#root`, which is only what the shell
 * itself renders into; a dropdown or dialog portals out of `#root` to a
 * sibling of it, still under `<body>`.
 *
 * `useLayoutEffect`, not `useEffect`: the active tab pill and the active
 * sidebar item read their tint off `--secondary`/`--sidebar-accent` on first
 * paint, and an effect that ran after that paint would show one grey frame
 * before snapping to the chosen hue.
 */
export function useHighlightTint(): void {
  const background = useAtomValue(backgroundAtom)

  useLayoutEffect(() => {
    if (background === 'none') return

    const tokens =
      `${HIGHLIGHT_TINT_CLASS_NAME[background]} ${HIGHLIGHT_TINT_ALIAS_CLASS_NAME}`.split(/\s+/)
    document.body.classList.add(...tokens)
    return () => document.body.classList.remove(...tokens)
  }, [background])
}
