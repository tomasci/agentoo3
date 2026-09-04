import { useTranslation } from 'react-i18next'
import { Menu, type MenuAction } from '@/shared/ui'
import { useTabLabel } from './tab-bar'
import styles from './tab-switcher.module.scss'
import { useTabs } from './use-tabs'

/**
 * The phone alternative to the tab row: the active tab's name in a
 * control-height picker, opening a menu of every tab plus the two actions the
 * row spreads across the [+] button and each tab's own close button.
 *
 * `useTabs` is safe to call again here — it holds no effects of its own (see
 * its docblock) — so this needs no state lifted from the row and no
 * bookkeeping duplicated between the two.
 *
 * Closing is offered for the tab you are already on, not one per row: a close
 * button per item would need its own `<button>` inside a `menuitem`, the
 * exact nested-button problem tab-bar.tsx's docblock already ruled out for
 * the row itself.
 */
export function TabSwitcher() {
  const { t } = useTranslation()
  const { tabs, activeId, active, addTab, selectTab, closeTab } = useTabs()
  const labelFor = useTabLabel()

  const items: MenuAction[] = [
    ...tabs.map((tab) => ({
      id: tab.id,
      label: labelFor(tab),
      onSelect: () => selectTab(tab.id),
      current: tab.id === activeId,
    })),
    { id: '__add', label: t('tabs.add'), onSelect: addTab },
    ...(active && active.kind !== 'system'
      ? [
          {
            id: '__close',
            label: t('tabs.close', { name: labelFor(active) }),
            onSelect: () => closeTab(active.id),
            destructive: true,
          },
        ]
      : []),
  ]

  const triggerLabel = active ? labelFor(active) : t('tabs.system')

  return (
    <div className={styles.root}>
      <Menu
        trigger={<span className={styles.triggerLabel}>{triggerLabel}</span>}
        items={items}
        triggerVariant="field"
      />
    </div>
  )
}
