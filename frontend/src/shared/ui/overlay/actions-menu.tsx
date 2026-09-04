import { Menu, Portal } from '@ark-ui/react'
import { useTranslation } from 'react-i18next'
import { cx } from '../lib/cx'
import styles from './actions-menu.module.scss'

export interface MenuAction {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

/** The three-dots menu on a row. */
export function ActionsMenu({ actions, label }: { actions: MenuAction[]; label?: string }) {
  const { t } = useTranslation()

  // A trigger with nothing behind it is a dead end, not an empty state worth
  // rendering — the row it sits on just has no actions.
  if (actions.length === 0) return null

  return (
    <Menu.Root
      onSelect={(details) => {
        const action = actions.find((a) => a.id === details.value)
        // Ark fires onSelect after closing, which is what we want: a dialog
        // opened from here is not fighting the menu for focus.
        action?.onSelect()
      }}
    >
      <Menu.Trigger className={styles.trigger} aria-label={label ?? t('common.actions')}>
        ⋯
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.content}>
            {actions.map((action) => (
              <Menu.Item
                key={action.id}
                value={action.id}
                disabled={action.disabled}
                className={cx(styles.item, action.destructive && styles.itemDestructive)}
              >
                {action.label}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}
