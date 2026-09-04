import { ark } from '@ark-ui/react'
import type { ComponentPropsWithRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../lib/cx'
import type { NoStyle, Size } from '../lib/types'
import styles from './button.module.scss'
import { Spinner } from './spinner'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

// Every existing call site fills the button with the accent colour; defaulting
// to secondary here would silently restyle all of them before a screen is
// ever reviewed.
//
// Each value is cast individually, not the object literal as a whole: vite's
// ambient `*.module.scss` type is an index signature, so under
// `noUncheckedIndexedAccess` every `styles.x` reads as `string | undefined`.
// Casting per property keeps the Record's own exhaustiveness check live — an
// added variant with no matching class still fails the build; casting the
// whole literal (`as Record<...>`) would silence that check along with the
// property type.
const VARIANT: Record<ButtonVariant, string> = {
  primary: styles.variantPrimary as string,
  secondary: styles.variantSecondary as string,
  ghost: styles.variantGhost as string,
  danger: styles.variantDanger as string,
}
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

interface ButtonProps extends NoStyle<ComponentPropsWithRef<'button'>> {
  variant?: ButtonVariant
  size?: Size
  loading?: boolean
  loadingLabel?: string
  fullWidth?: boolean
  /** Renders as the single child element instead of a `<button>`. See the escape hatch in the component contract. */
  asChild?: boolean
}

/**
 * Ark's factory keeps the polymorphic `asChild` behaviour while letting us own
 * the styling; Ark ships no CSS of its own.
 *
 * Children are always wrapped in `.label` so loading never changes the
 * button's width: `[data-loading] .label` hides the text and the spinner sits
 * absolutely centred over the same box. `asChild` hands rendering entirely to
 * the child, so that wrapping — and the loading spinner — only applies when
 * Button renders its own `<button>`.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel,
  fullWidth = false,
  asChild = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const { t } = useTranslation()

  return (
    <ark.button
      asChild={asChild}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      className={cx(styles.root, VARIANT[variant], SIZE[size], fullWidth && styles.fullWidth)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && (
            <span className={styles.spinner}>
              <Spinner
                label={loadingLabel ?? t('common.working')}
                labelPlacement="sr-only"
                size={size}
              />
            </span>
          )}
          <span className={styles.label}>{children}</span>
        </>
      )}
    </ark.button>
  )
}
