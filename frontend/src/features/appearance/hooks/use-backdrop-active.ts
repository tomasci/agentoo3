import { useAtomValue } from 'jotai'
import { backgroundAtom, backgroundPatternAtom, isBackgroundActive } from '@/shared/store/ui'

/**
 * Whether either persisted choice is anything but `'none'` — root-layout.tsx,
 * sidebar.tsx and tab-bar.tsx each decide their own glass/transparency from
 * exactly this, and used to each read both atoms and call
 * `isBackgroundActive` by hand; one hook means the three can't quietly drift
 * out of step with each other.
 */
export function useBackdropActive(): boolean {
  const background = useAtomValue(backgroundAtom)
  const pattern = useAtomValue(backgroundPatternAtom)
  return isBackgroundActive(background, pattern)
}
