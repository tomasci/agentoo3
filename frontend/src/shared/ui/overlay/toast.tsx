import type { ToastOptions } from '@ark-ui/react'
import { Toast as ArkToast, Toaster as ArkToaster, createToaster, Portal } from '@ark-ui/react'
import { cx } from '../lib/cx'
import styles from './toast.module.scss'

type ToastTone = 'success' | 'danger' | 'accent'

/** The only three zag `type`s a toast from this app ever carries. Not
 * `ToastOptions['type']` itself: that widens to `(string & {})` for
 * autocomplete, which makes a `Record` over it meaningless — every key would
 * have to be listed and none of them could be. */
type ZagToastType = 'success' | 'error' | 'info'

/**
 * `@zag-js/toast`'s own `type` feeds straight into its internal priority
 * table (`toast.store.ts`'s `priorities`), which recognises exactly five
 * literal keys — success/error/loading/info/warning — and destructures
 * `undefined` for anything else, throwing. Our tone vocabulary is a
 * different, larger set (`danger`/`accent` name no zag key), so it is
 * translated here rather than passed straight through as it used to be: that
 * version crashed the instant any toast used a tone other than the default
 * `'success'`, which nothing had yet, until this feature's first `tone:
 * 'danger'` call turned up the bug.
 */
const TONE_TO_ZAG_TYPE: Record<ToastTone, ZagToastType> = {
  success: 'success',
  danger: 'error',
  accent: 'info',
}

// The reverse of the map above, read back off `item.type` to pick a CSS
// class. Safe to key straight off zag's own three strings: `toast()` below
// is the one producer of every toast in this app, so nothing ever hands
// `ArkToaster` a `type` this map does not know about.
const ZAG_TYPE_TONE_CLASS: Record<ZagToastType, string> = {
  success: styles.toneSuccess as string,
  error: styles.toneDanger as string,
  info: styles.toneAccent as string,
}

function isZagToastType(value: ToastOptions['type']): value is ZagToastType {
  return value === 'success' || value === 'error' || value === 'info'
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
  toaster.create({ title, description, type: TONE_TO_ZAG_TYPE[tone], duration })
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
            className={cx(
              styles.toast,
              isZagToastType(item.type) && ZAG_TYPE_TONE_CLASS[item.type],
            )}
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
