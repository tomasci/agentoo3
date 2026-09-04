import { Menu as ArkMenu, Portal } from '@ark-ui/react'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './menu.module.scss'

export interface MenuAction {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
  /** Marks the item you are already on; renders aria-current + a check. */
  current?: boolean
}

type MenuTriggerVariant = 'icon' | 'field'

// See button.tsx for why each value is cast individually rather than the
// object literal as a whole.
const TRIGGER_VARIANT: Record<MenuTriggerVariant, string> = {
  icon: styles.triggerVariantIcon as string,
  field: styles.triggerVariantField as string,
}

interface MenuProps {
  /** Phrasing content only — the shell owns the <button>, so never pass a Button. */
  trigger: ReactNode
  /** Accessible name, required when `trigger` is a glyph. */
  label?: string
  items: MenuAction[]
  triggerVariant?: MenuTriggerVariant
}

/**
 * The shell every dropdown menu in the app is built from: a trigger button,
 * portaled content, one item per action. `ActionsMenu` is the first preset —
 * the ⋯ row action, `triggerVariant="icon"` — and the phone tab switcher is
 * the second, which is why the trigger also has a `"field"` look: a
 * control-height, full-width picker rather than a compact square.
 */
export function Menu({ trigger, label, items, triggerVariant = 'icon' }: MenuProps) {
  return (
    <ArkMenu.Root
      onSelect={(details) => {
        const action = items.find((item) => item.id === details.value)
        // Ark fires onSelect after closing, which is what we want: a dialog
        // opened from here is not fighting the menu for focus.
        action?.onSelect()
      }}
    >
      <ArkMenu.Trigger
        className={cx(styles.trigger, TRIGGER_VARIANT[triggerVariant])}
        aria-label={label}
      >
        {trigger}
      </ArkMenu.Trigger>
      <Portal>
        <ArkMenu.Positioner>
          <ArkMenu.Content className={styles.content}>
            {items.map((item) => (
              <ArkMenu.Item
                key={item.id}
                value={item.id}
                disabled={item.disabled}
                // 'page' rather than 'true': the same true, simple fact the
                // tab row states with aria-current="page" on its own button.
                aria-current={item.current ? 'page' : undefined}
                className={cx(styles.item, item.destructive && styles.itemDestructive)}
              >
                {item.current && (
                  <span className={styles.itemCheck} aria-hidden="true">
                    ✓
                  </span>
                )}
                <span className={styles.itemLabel}>{item.label}</span>
              </ArkMenu.Item>
            ))}
          </ArkMenu.Content>
        </ArkMenu.Positioner>
      </Portal>
    </ArkMenu.Root>
  )
}
