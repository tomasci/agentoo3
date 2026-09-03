import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../core/button'
import { Dialog } from './dialog'

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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      role="alertdialog"
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.delete')}
          </Button>
        </>
      }
    />
  )
}
