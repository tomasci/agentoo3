import { Select as ArkSelect, createListCollection, Portal } from '@ark-ui/react'
import type { Ref } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../lib/cx'
import type { Size } from '../lib/types'
import styles from './select.module.scss'

// See core/button.tsx for why each value is cast individually rather than
// the object literal as a whole.
const SIZE: Record<Size, string> = {
  sm: styles.sizeSm as string,
  md: styles.sizeMd as string,
  lg: styles.sizeLg as string,
}

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface SelectProps {
  options: readonly SelectOption[]
  value?: string | null
  defaultValue?: string | null
  onValueChange?: (value: string | null) => void
  placeholder?: string
  name?: string
  disabled?: boolean
  size?: Size
  /**
   * Lands on the hidden `<select>`, not the trigger button — that's the real
   * `HTMLSelectElement` react-hook-form's `register()` needs. See
   * ui-forms.test.tsx for the verified behaviour and the report for the
   * `register()` verdict.
   */
  ref?: Ref<HTMLSelectElement>
}

/**
 * Ark's full `Select` (listbox), not `Field.Select` — a native `<select>`
 * can't style a two-line option or a disabled one, which is why this exists.
 * Single-select only: the public API is a single `value`/`onValueChange`,
 * Ark's array-shaped value stays an internal detail.
 */
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  name,
  disabled = false,
  size = 'md',
  ref,
}: SelectProps) {
  const { t } = useTranslation()
  const collection = useMemo(() => createListCollection({ items: options }), [options])

  return (
    <ArkSelect.Root
      collection={collection}
      value={value !== undefined ? (value == null ? [] : [value]) : undefined}
      defaultValue={
        defaultValue !== undefined ? (defaultValue == null ? [] : [defaultValue]) : undefined
      }
      onValueChange={(details) => onValueChange?.(details.value[0] ?? null)}
      disabled={disabled}
      className={styles.root}
    >
      <ArkSelect.Control className={styles.control}>
        <ArkSelect.Trigger className={cx(styles.trigger, SIZE[size])}>
          <ArkSelect.ValueText placeholder={placeholder} className={styles.valueText} />
          <ArkSelect.Indicator className={styles.indicator}>▾</ArkSelect.Indicator>
        </ArkSelect.Trigger>
      </ArkSelect.Control>
      {/* Always rendered, not gated on `name`: `ref` needs a real element to
          land on regardless of whether this select ever posts a native form. */}
      <ArkSelect.HiddenSelect ref={ref} name={name} />
      <Portal>
        <ArkSelect.Positioner className={styles.positioner}>
          <ArkSelect.Content className={styles.content}>
            {options.length === 0 ? (
              <div className={styles.empty}>{t('common.noOptions')}</div>
            ) : (
              options.map((option) => (
                <ArkSelect.Item key={option.value} item={option} className={styles.item}>
                  <span className={styles.itemMain}>
                    <ArkSelect.ItemText className={styles.itemText}>
                      {option.label}
                    </ArkSelect.ItemText>
                    {/* Zag's own select machine marks the selected option with
                        `data-state`, not `data-selected` (that attribute belongs
                        to its listbox/combobox machines) — styled on `.item`
                        accordingly. */}
                    <ArkSelect.ItemIndicator className={styles.itemIndicator}>
                      ✓
                    </ArkSelect.ItemIndicator>
                  </span>
                  {option.description && (
                    <span className={styles.itemDescription}>{option.description}</span>
                  )}
                </ArkSelect.Item>
              ))
            )}
          </ArkSelect.Content>
        </ArkSelect.Positioner>
      </Portal>
    </ArkSelect.Root>
  )
}
