import { useTranslation } from 'react-i18next'
import { Menu, type MenuAction } from './menu'

export type { MenuAction }

/** The three-dots menu on a row — `Menu`'s icon-trigger preset. */
export function ActionsMenu({ actions, label }: { actions: MenuAction[]; label?: string }) {
  const { t } = useTranslation()

  // A trigger with nothing behind it is a dead end, not an empty state worth
  // rendering — the row it sits on just has no actions.
  if (actions.length === 0) return null

  return (
    <Menu trigger="⋯" label={label ?? t('common.actions')} items={actions} triggerVariant="icon" />
  )
}
