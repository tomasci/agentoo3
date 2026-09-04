import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import type { Tab } from '@/shared/store/tabs'
import styles from './tab-bar.module.scss'
import { TabSwitcher } from './tab-switcher'
import { useTabs } from './use-tabs'

/**
 * A tab's display name: fixed for the system tab and an empty picker, read
 * live off the project list for a project tab so a rename updates every open
 * tab rather than just the one that opened it.
 *
 * Shared by the row below and `TabSwitcher`, so the two shapes never say
 * something different about the same tab.
 */
export function useTabLabel() {
  const { t } = useTranslation()
  const { data: projects } = useProjects()

  return (tab: Tab) => {
    if (tab.kind === 'system') return t('tabs.system')
    if (tab.kind === 'new') return t('tabs.newTab')
    const project = projects?.find((candidate) => candidate.id === tab.projectId)
    return project?.name ?? t('tabs.loading')
  }
}

/**
 * The row of tabs across the top of the workspace, and its phone alternative.
 *
 * The system tab is first and permanent; project tabs follow in the order they
 * were opened, and the [+] at the end starts an empty one. A project's tab is
 * labelled with its current name, read from the project list rather than copied
 * at open time, so renaming a project renames its tab.
 *
 * This is a `nav`/list, not an ARIA tablist: a tablist promises a
 * `role="tabpanel"` for each tab to control, and there has never been one —
 * the "panel" is the whole router outlet, shared by every tab. That left a
 * `role="tab"` with no `aria-controls` pointing anywhere, which announces a
 * relationship to assistive tech that doesn't exist. `aria-current="page"`
 * says the true, simpler thing: this is the page you're on. Roving
 * `tabIndex`/arrow-key stepping went with it — that behaviour belongs to the
 * tab widget pattern, and a plain list of buttons is already correct with the
 * browser's normal Tab order, one stop per button.
 *
 * Below `sm`, the row and its [+] give way to `TabSwitcher` — a picker naming
 * the active tab, since a row that scrolls sideways past a twentieth project
 * is worse than a menu on a screen too narrow for either to show every tab
 * at once. The two shapes live in *separate* `nav` landmarks sharing the same
 * accessible name, rather than one landmark whose children swap out: hiding
 * only the row's children with `display: none` would leave that landmark
 * empty of content whenever the switcher is the one showing, and an empty
 * landmark is worse than one of two that is never both present at once
 * (`display: none` removes a `<nav>` from the accessibility tree the same way
 * it removes anything else). Which one is visible is CSS alone, in
 * tab-bar.module.scss — both are always in the DOM, so there is no flash of
 * the wrong shape while a media query is still being evaluated in JS.
 */
export function TabBar() {
  const { t } = useTranslation()
  const { tabs, activeId, addTab, selectTab, closeTab } = useTabs()
  const labelFor = useTabLabel()

  return (
    <>
      <nav className={styles.bar} aria-label={t('tabs.label')}>
        <ul className={styles.list}>
          {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
              // The close button is a real button, so the tab itself cannot be one:
              // a button inside a button is invalid HTML and unreachable by keyboard.
              <li
                key={tab.id}
                className={`${styles.tab} ${active ? styles.tabActive : ''} ${
                  tab.kind === 'system' ? styles.tabSystem : ''
                }`}
                // Middle-click closes, the way it does in a browser.
                onAuxClick={(event) => {
                  if (event.button === 1 && tab.kind !== 'system') {
                    event.preventDefault()
                    closeTab(tab.id)
                  }
                }}
              >
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  className={styles.tabButton}
                  onClick={() => selectTab(tab.id)}
                >
                  {tab.kind === 'system' && (
                    <span className={styles.tabIcon} aria-hidden="true">
                      ⚙
                    </span>
                  )}
                  <span className={styles.tabLabel}>{labelFor(tab)}</span>
                </button>

                {tab.kind !== 'system' && (
                  <button
                    type="button"
                    className={styles.close}
                    aria-label={t('tabs.close', { name: labelFor(tab) })}
                    onClick={() => closeTab(tab.id)}
                  >
                    ✕
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        <button type="button" className={styles.add} aria-label={t('tabs.add')} onClick={addTab}>
          +
        </button>
      </nav>

      <nav className={styles.barPhone} aria-label={t('tabs.label')}>
        <TabSwitcher />
      </nav>
    </>
  )
}
