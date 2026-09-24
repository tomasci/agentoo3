import { ChevronsUpDownIcon, PlusIcon, SettingsIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { useTabLabel } from './tab-bar'
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
 * item per row would need its own click target inside a `MenuRadioItem` that
 * already claims the whole row for selecting that tab — the same nested-target
 * problem tab-bar.tsx's docblock rules out for the row's own buttons.
 */
export function TabSwitcher() {
  const { t } = useTranslation()
  const { tabs, activeId, active, addTab, selectTab, closeTab } = useTabs()
  const labelFor = useTabLabel()

  const triggerLabel = active ? labelFor(active) : t('tabs.system')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="min-w-0 flex-1 justify-between gap-1.5" />}
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronsUpDownIcon className="shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={activeId}
          onValueChange={(value) => selectTab(value as string)}
        >
          {tabs.map((tab) => (
            <DropdownMenuRadioItem key={tab.id} value={tab.id} closeOnClick>
              {tab.kind === 'system' && <SettingsIcon />}
              <span className="truncate">{labelFor(tab)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={addTab}>
          <PlusIcon />
          {t('tabs.add')}
        </DropdownMenuItem>
        {active && active.kind !== 'system' && (
          <DropdownMenuItem variant="destructive" onClick={() => closeTab(active.id)}>
            <XIcon />
            {t('tabs.close', { name: labelFor(active) })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
