import { useAtomValue } from 'jotai'
import { cn } from '@/shared/lib/utils'
import { backgroundAtom, backgroundPatternAtom } from '@/shared/store/ui'
import { BACKGROUND_CLASS_NAME } from '../lib/catalog'
import { BackgroundPattern } from './background-pattern'

/**
 * The shell's own chosen backdrop. Mounted in root-layout.tsx's `Shell` as
 * the first child of `SidebarProvider`, `absolute inset-0 -z-10` and
 * `aria-hidden` — it paints behind the tab bar, the sidebar and the status
 * bar (the wrapper's own `relative isolate` is what lets a negative z-index
 * resolve against that wrapper instead of escaping it) without taking a hit
 * target or a place in the tab order. Renders nothing at all when both
 * choices are `'none'`, which is the default: the shell this feature didn't
 * touch has to stay exactly what it was.
 */
export function BackgroundBackdrop() {
  const background = useAtomValue(backgroundAtom)
  const pattern = useAtomValue(backgroundPatternAtom)

  if (background === 'none' && pattern === 'none') return null

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 -z-10',
        background !== 'none' && BACKGROUND_CLASS_NAME[background],
      )}
    >
      {pattern !== 'none' && (
        <BackgroundPattern pattern={pattern} className="absolute inset-0 h-full w-full" />
      )}
    </div>
  )
}
