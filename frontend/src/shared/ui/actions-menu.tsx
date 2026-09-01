import { Menu, Portal } from '@ark-ui/react'
import { useTranslation } from 'react-i18next'
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
        <Menu.Positioner className={styles.positioner}>
          <Menu.Content className={styles.content}>
            {actions.map((action) => (
              <Menu.Item
                key={action.id}
                value={action.id}
                disabled={action.disabled}
                className={`${styles.item} ${action.destructive ? styles.destructive : ''}`}
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
