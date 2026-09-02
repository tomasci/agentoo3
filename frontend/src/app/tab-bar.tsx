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
 */
export function TabBar() {
  const { t } = useTranslation()
  const { tabs, activeId, addTab, selectTab, closeTab } = useTabs()
  const { data: projects } = useProjects()

  // A tablist is expected to move with the arrow keys, with only the selected
  // tab in the page's tab order. Without this the role would promise a keyboard
  // interface the row does not have.
  const step = (from: string, delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === from)
    const next = tabs[index + delta]
    if (next) selectTab(next.id)
  }

  const labelFor = (tab: Tab) => {
    if (tab.kind === 'system') return t('tabs.system')
    if (tab.kind === 'new') return t('tabs.newTab')
    const project = projects?.find((candidate) => candidate.id === tab.projectId)
    return project?.name ?? t('tabs.loading')
  }

  return (
    <div className={styles.bar} role="tablist" aria-label={t('tabs.label')}>
      {tabs.map((tab) => {
        const selected = tab.id === activeId
        return (
          // The close button is a real button, so the tab itself cannot be one:
          // a button inside a button is invalid HTML and unreachable by keyboard.
          <div
            key={tab.id}
            className={`${styles.tab} ${selected ? styles.tabActive : ''} ${
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
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={styles.tabButton}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') step(tab.id, 1)
                else if (event.key === 'ArrowLeft') step(tab.id, -1)
                else return
                event.preventDefault()
              }}
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
          </div>
        )
      })}

      <button type="button" className={styles.add} aria-label={t('tabs.add')} onClick={addTab}>
        +
      </button>
    </div>
  )
}
