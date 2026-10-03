import { useAtomValue } from 'jotai'
import { useLayoutEffect } from 'react'
import { accentColorAtom } from '@/shared/store/ui'
import { ACCENT_COLOR_CLASS_NAME, ACCENT_COLOR_FIXED_TONE_CLASS_NAME } from '../lib/catalog'

/**
 * Re-points `--primary` to the reader's chosen accent colour — see
 * `lib/catalog.ts`'s own comments on `ACCENT_COLOR_CLASS_NAME`/
 * `ACCENT_COLOR_FIXED_TONE_CLASS_NAME` for which tokens that reaches and
 * which subtrees it deliberately skips. Mounted in `root-layout.tsx`'s
 * `RootLayout`, before the bare-shell early return — unlike
 * `useHighlightTint` (mounted in `Shell`), the accent is reader-wide like the
 * theme: the editor launcher opens with no app shell around it at all, but
 * its own buttons are still calls to attention and should carry the chosen
 * accent too.
 *
 * Shares no token with `useHighlightTint`: that hook re-points `--accent`
 * (plus its three aliases); this one re-points `--primary` (plus the
 * fixed-tone subtree's own copy of it). Both can add/remove their own
 * classes on `document.body` independently without either cleanup ever
 * stripping the other's tokens.
 *
 * `'none'` adds nothing at all — today's exact look, the same contract
 * `useHighlightTint` holds for `background === 'none'`.
 *
 * Classes land on `document.body`, not `document.documentElement` — same
 * reasoning as `useHighlightTint`'s own comment: this project's `dark:`
 * variant is a descendant selector and `.dark` itself sits on `<html>`, and
 * `<body>` is the one ancestor every portal (a menu, a dialog) mounts under.
 *
 * `useLayoutEffect`, not `useEffect`: a primary `Button` reads `--primary` on
 * first paint, and an effect that ran after that paint would show one
 * default-grey frame before snapping to the chosen hue.
 */
export function useAccentColor(): void {
  const accentColor = useAtomValue(accentColorAtom)

  useLayoutEffect(() => {
    if (accentColor === 'none') return

    const tokens =
      `${ACCENT_COLOR_CLASS_NAME[accentColor]} ${ACCENT_COLOR_FIXED_TONE_CLASS_NAME}`.split(/\s+/)
    document.body.classList.add(...tokens)
    return () => document.body.classList.remove(...tokens)
  }, [accentColor])
}
