import { Tooltip as ArkTooltip, Portal } from '@ark-ui/react'
import type { ReactElement, ReactNode } from 'react'
import { usePortalContainer } from '../lib/portal-container'
import styles from './tooltip.module.scss'

type Placement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  content: ReactNode
  /** The trigger, rendered via `asChild` so this never adds a wrapper element. */
  children: ReactElement
  placement?: Placement
  openDelay?: number
  closeDelay?: number
}

/**
 * Replaces a native `title=` attribute: untouchable on touch, unstyleable,
 * and invisible to keyboard users since a plain element never gets `title`
 * read on focus.
 *
 * Ark wires the accessible relationship (aria-describedby, hover/focus open,
 * Escape to dismiss) but will not make an unfocusable trigger reachable —
 * the child passed in must already be a button or otherwise in the tab
 * order. See the component's callers for this requirement.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  openDelay = 300,
  closeDelay = 100,
}: TooltipProps) {
  // undefined outside a Dialog: Ark's own "portal to document.body" fallback.
  // Included even though today's only failure mode (1400 > 1200) already
  // worked by accident: the rule is every portalled overlay passes
  // container, with no exceptions to remember.
  const portalContainer = usePortalContainer()

  return (
    <ArkTooltip.Root positioning={{ placement }} openDelay={openDelay} closeDelay={closeDelay}>
      <ArkTooltip.Trigger asChild>{children}</ArkTooltip.Trigger>
      <Portal container={portalContainer}>
        <ArkTooltip.Positioner>
          <ArkTooltip.Content className={styles.content}>{content}</ArkTooltip.Content>
        </ArkTooltip.Positioner>
      </Portal>
    </ArkTooltip.Root>
  )
}
