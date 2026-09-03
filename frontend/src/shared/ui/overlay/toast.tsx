import type { ToastOptions } from '@ark-ui/react'
import { Toast as ArkToast, Toaster as ArkToaster, createToaster, Portal } from '@ark-ui/react'
import { cx } from '../lib/cx'
import styles from './toast.module.scss'

type ToastTone = 'success' | 'danger' | 'accent'

// Zag's `type` field is a loosely-typed string (its built-ins are
// success/error/loading/info/warning); our own tone vocabulary is passed
// straight through rather than translated, so the value read back off each
// toast in the render below is exactly what `toast()` was called with.
const TONE_CLASS: Record<ToastTone, string> = {
  success: styles.toneSuccess as string,
  danger: styles.toneDanger as string,
  accent: styles.toneAccent as string,
}

function isToastTone(value: ToastOptions['type']): value is ToastTone {
  return value === 'success' || value === 'danger' || value === 'accent'
}

/**
 * Module singleton — one toaster for the whole app, matching `<Toaster />`
 * being mounted exactly once in providers.tsx.
 */
export const toaster = createToaster({ placement: 'bottom-end', gap: 12 })

export function toast({
  title,
  description,
  tone = 'success',
  duration = 3000,
}: {
  title: string
  description?: string
  tone?: ToastTone
  duration?: number
}) {
  toaster.create({ title, description, type: tone, duration })
}

/**
 * Replaces the hand-rolled useState+setTimeout confirmations at 1500/2000/
 * 2000ms — a toast survives the triggering component unmounting, which a
 * local timeout does not.
 *
 * @zag-js/toast puts an inline `zIndex: 2147483647` on the viewport that
 * `createToaster` cannot configure; `--z-toast` is declared below for
 * completeness but is advisory only — fighting the inline style with
 * `!important` is not worth it (see component-contract.md).
 */
export function Toaster() {
  return (
    <Portal>
      <ArkToaster toaster={toaster} className={styles.root}>
        {(item: ToastOptions) => (
          <ArkToast.Root
            className={cx(styles.toast, isToastTone(item.type) && TONE_CLASS[item.type])}
          >
            <ArkToast.Title className={styles.title}>{item.title}</ArkToast.Title>
            {item.description && (
              <ArkToast.Description className={styles.description}>
                {item.description}
              </ArkToast.Description>
            )}
            <ArkToast.CloseTrigger className={styles.closeTrigger}>×</ArkToast.CloseTrigger>
          </ArkToast.Root>
        )}
      </ArkToaster>
    </Portal>
  )
}
