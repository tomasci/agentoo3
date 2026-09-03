import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import type { Tab } from '@/shared/store/tabs'
import styles from './tab-bar.module.scss'
import { useTabs } from './use-tabs'

/**
 * The row of tabs across the top of the workspace.
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
 */
export function TabBar() {
  const { t } = useTranslation()
  const { tabs, activeId, addTab, selectTab, closeTab } = useTabs()
  const { data: projects } = useProjects()

  const labelFor = (tab: Tab) => {
    if (tab.kind === 'system') return t('tabs.system')
    if (tab.kind === 'new') return t('tabs.newTab')
    const project = projects?.find((candidate) => candidate.id === tab.projectId)
    return project?.name ?? t('tabs.loading')
  }

  return (
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
  )
}
