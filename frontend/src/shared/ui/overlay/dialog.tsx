import { Dialog as ArkDialog, Portal } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import type { Size } from '../lib/types'
import styles from './dialog.module.scss'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: Size
  role?: 'dialog' | 'alertdialog'
}

/**
 * The shell every dialog in the app is built from — 7 call sites used to
 * re-declare their own open state and re-implement the backdrop/positioner
 * stack by hand. `ConfirmDialog` is the first consumer; anything that needs a
 * modal renders its own body/footer through this rather than reaching for
 * `Dialog.Root` directly.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'sm',
  role = 'dialog',
}: DialogProps) {
  return (
    <ArkDialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)} role={role}>
      <Portal>
        <ArkDialog.Backdrop className={styles.backdrop} />
        <ArkDialog.Positioner className={styles.positioner}>
          <ArkDialog.Content className={cx(styles.content, SIZE[size])}>
            <ArkDialog.Title className={styles.title}>{title}</ArkDialog.Title>
            {description && (
              <ArkDialog.Description className={styles.description}>
                {description}
              </ArkDialog.Description>
            )}
            {children && <div className={styles.body}>{children}</div>}
            {footer && <div className={styles.footer}>{footer}</div>}
          </ArkDialog.Content>
        </ArkDialog.Positioner>
      </Portal>
    </ArkDialog.Root>
  )
}
