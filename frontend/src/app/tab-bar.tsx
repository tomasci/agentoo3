import { Plus, Settings, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import type { Tab, TabKind } from '@/shared/store/tabs'
import { Button } from '@/shared/ui/button'
import { ButtonGroup } from '@/shared/ui/button-group'
import { SidebarTrigger } from '@/shared/ui/sidebar'
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
 * Below `md`, the row and its [+] give way to `TabSwitcher` — a picker naming
 * the active tab, since a row that scrolls sideways past a twentieth project
 * is worse than a menu on a screen too narrow for either to show every tab
 * at once. The two shapes live in *separate* `nav` landmarks sharing the same
 * accessible name, rather than one landmark whose children swap out: hiding
 * only the row's children with `hidden` would leave that landmark empty of
 * content whenever the switcher is the one showing, and an empty landmark is
 * worse than one of two that is never both present at once (`hidden` removes
 * a `<nav>` from the accessibility tree the same way it removes anything
 * else). Which one is visible is CSS alone (Tailwind's `md:` variant) — both
 * are always in the DOM, so there is no flash of the wrong shape while a media
 * query is still being evaluated in JS.
 */
export function TabBar({ mode }: { mode: TabKind }) {
  const { t } = useTranslation()
  const { tabs, activeId, addTab, selectTab, closeTab } = useTabs()
  const labelFor = useTabLabel()

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 px-2">
      {/* An empty tab has no sidebar to toggle (root-layout.tsx forces it
          closed and empty in this mode) — a trigger with nothing behind it
          would be a control that does nothing. */}
      {mode !== 'new' && <SidebarTrigger aria-label={t('shell.toggleSidebar')} />}

      <nav
        aria-label={t('tabs.label')}
        className="hidden min-w-0 flex-1 items-stretch gap-1 self-stretch overflow-x-auto md:flex"
      >
        <ul className="flex min-w-0 items-stretch gap-1 py-1.5">
          {tabs.map((tab) => {
            const active = tab.id === activeId
            const variant = active ? 'secondary' : 'ghost'
            return (
              // The close button is a real button, so the tab itself cannot be one:
              // a button inside a button is invalid HTML and unreachable by keyboard.
              <li
                key={tab.id}
                className="min-w-0"
                // Middle-click closes, the way it does in a browser.
                onAuxClick={(event) => {
                  if (event.button === 1 && tab.kind !== 'system') {
                    event.preventDefault()
                    closeTab(tab.id)
                  }
                }}
              >
                <ButtonGroup>
                  <Button
                    type="button"
                    variant={variant}
                    aria-current={active ? 'page' : undefined}
                    className="min-w-0 max-w-56 justify-start gap-1.5"
                    onClick={() => selectTab(tab.id)}
                  >
                    {tab.kind === 'system' && <Settings aria-hidden="true" />}
                    <span className="truncate">{labelFor(tab)}</span>
                  </Button>

                  {tab.kind !== 'system' && (
                    // `icon`, not `icon-xs`: it has to match the label button's own
                    // (default-size) height, or the pair reads as two mismatched
                    // controls rather than one pill — same height as the system tab
                    // and the [+] button (also `icon`) so the whole row lines up.
                    <Button
                      type="button"
                      variant={variant}
                      size="icon"
                      aria-label={t('tabs.close', { name: labelFor(tab) })}
                      onClick={() => closeTab(tab.id)}
                    >
                      <X />
                    </Button>
                  )}
                </ButtonGroup>
              </li>
            )
          })}
        </ul>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 self-center"
          aria-label={t('tabs.add')}
          onClick={addTab}
        >
          <Plus />
        </Button>
      </nav>

      <nav aria-label={t('tabs.label')} className="flex min-w-0 flex-1 md:hidden">
        <TabSwitcher />
      </nav>
    </header>
  )
}
