import { Collapsible as ArkCollapsible } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import type { Tone } from '../lib/types'
import styles from './collapsible.module.scss'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const BADGE_TONE: Record<Tone, string> = {
  neutral: styles.badgeToneNeutral as string,
  accent: styles.badgeToneAccent as string,
  success: styles.badgeToneSuccess as string,
  warning: styles.badgeToneWarning as string,
  danger: styles.badgeToneDanger as string,
}

interface CollapsibleProps {
  title: ReactNode
  /**
   * Replaces the old `badgeClass` escape hatch. Track A owns `Badge`; this
   * renders its own local pill rather than importing a component that may
   * not exist yet — Phase 4 can swap it in once it does.
   */
  badge?: { label: string; tone?: Tone }
  note?: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** @default true — matches the hard unmount the hand-rolled version had. */
  unmountOnExit?: boolean
  children: ReactNode
}

/** A row that is a heading until you open it. */
export function Collapsible({
  title,
  badge,
  note,
  open,
  defaultOpen = false,
  onOpenChange,
  unmountOnExit = true,
  children,
}: CollapsibleProps) {
  return (
    <ArkCollapsible.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(details) => onOpenChange?.(details.open)}
      unmountOnExit={unmountOnExit}
      className={styles.root}
    >
      <ArkCollapsible.Trigger className={styles.trigger}>
        <ArkCollapsible.Indicator className={styles.indicator} aria-hidden="true">
          ▶
        </ArkCollapsible.Indicator>
        {badge && (
          <span className={cx(styles.badge, BADGE_TONE[badge.tone ?? 'neutral'])}>
            {badge.label}
          </span>
        )}
        <span className={styles.title}>{title}</span>
        {note && <span className={styles.note}>{note}</span>}
      </ArkCollapsible.Trigger>
      <ArkCollapsible.Content className={styles.content}>
        <div className={styles.body}>{children}</div>
      </ArkCollapsible.Content>
    </ArkCollapsible.Root>
  )
}
