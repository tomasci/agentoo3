import { CheckIcon, MoreHorizontalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'

export interface MenuAction {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
  /** Marks the item you are already on; renders aria-current + a check. */
  current?: boolean
}

/** The three-dots menu on a row. */
export function ActionsMenu({ actions, label }: { actions: MenuAction[]; label?: string }) {
  const { t } = useTranslation()

  // A trigger with nothing behind it is a dead end, not an empty state worth
  // rendering — the row it sits on just has no actions.
  if (actions.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label ?? t('common.actions')}
        render={<Button variant="ghost" size="icon-sm" />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            variant={action.destructive ? 'destructive' : 'default'}
            aria-current={action.current ? 'page' : undefined}
            onClick={action.onSelect}
          >
            {action.current && <CheckIcon aria-hidden="true" className="size-3.5" />}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
