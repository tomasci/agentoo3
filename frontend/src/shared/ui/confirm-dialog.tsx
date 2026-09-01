import { Dialog, Portal } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import styles from './confirm-dialog.module.scss'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel?: string
  /** Styles the confirm button as destructive. */
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
}

/**
 * A real dialog rather than window.confirm.
 *
 * window.confirm blocks the whole page, cannot show the name of the thing being
 * deleted with any formatting, is unstyleable, and is suppressible by the
 * browser — which would silently turn "are you sure" into "yes".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => onOpenChange(details.open)}
      role="alertdialog"
    >
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Description className={styles.description}>{description}</Dialog.Description>
            <div className={styles.actions}>
              <Dialog.CloseTrigger asChild>
                <Button type="button">{t('common.cancel')}</Button>
              </Dialog.CloseTrigger>
              <Button
                type="button"
                className={destructive ? styles.danger : undefined}
                disabled={busy}
                onClick={onConfirm}
              >
                {busy ? t('common.working') : (confirmLabel ?? t('common.delete'))}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
