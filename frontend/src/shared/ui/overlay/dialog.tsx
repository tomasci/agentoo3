import { Dialog as ArkDialog, Portal } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import { PortalContainerProvider, usePortalHost } from '../lib/portal-container'
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
  // Published so a Select/Menu/Tooltip opened from inside this dialog can
  // portal into Content instead of document.body — see
  // component-contract.md's "z-index and portal containers": that makes the
  // popup a DOM descendant of Content (inherits its stacking context, beats
  // any z-index race) and keeps it out of the one-shot aria-hidden walk
  // `@zag-js/dialog` runs over document.body's children on open.
  const host = usePortalHost()

  return (
    <ArkDialog.Root open={open} onOpenChange={(details) => onOpenChange(details.open)} role={role}>
      {/* Bare on purpose: nested dialogs are out of scope here. The fix for
          that is Dialog's own Portal reading usePortalContainer() too, so a
          dialog opened from inside another dialog nests the same way. */}
      <Portal>
        <ArkDialog.Backdrop className={styles.backdrop} />
        <ArkDialog.Positioner className={styles.positioner}>
          <ArkDialog.Content ref={host.ref} className={cx(styles.content, SIZE[size])}>
            {/* Never Positioner: that would make the popup Content's sibling,
                still caught by the aria-hidden walk above. Must be Content. */}
            <PortalContainerProvider value={host.container}>
              <ArkDialog.Title className={styles.title}>{title}</ArkDialog.Title>
              {description && (
                <ArkDialog.Description className={styles.description}>
                  {description}
                </ArkDialog.Description>
              )}
              {children && <div className={styles.body}>{children}</div>}
              {footer && <div className={styles.footer}>{footer}</div>}
            </PortalContainerProvider>
          </ArkDialog.Content>
        </ArkDialog.Positioner>
      </Portal>
    </ArkDialog.Root>
  )
}
