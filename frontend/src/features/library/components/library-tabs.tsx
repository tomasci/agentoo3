import { Link, useLocation } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { useSuggestions } from '../hooks/use-learning'

const VIEWS = [
  { id: 'library', path: '/library' },
  { id: 'suggested', path: '/library/suggested' },
  { id: 'rejected', path: '/library/rejected' },
] as const

function isActive(pathname: string, path: string): boolean {
  return path === '/library' ? pathname === '/library' : pathname.startsWith(path)
}

/**
 * The tab-style nav shared by all three Library list views.
 *
 * Tried shadcn's `Tabs` first (`npx shadcn add tabs`, per the brief) and
 * backed it out: Base UI's `Tabs.Tab` only ever renders a `<button>` with
 * `role="tab"`/`aria-selected`, which promises a nearby `tabpanel` an
 * assistive-tech user can reach — but these three "tabs" are full page
 * navigations with no panel at all, exactly the shape
 * `tests/workspace.test.tsx` already asserts the *workspace* tab row must
 * not be (see that file's "the tab row is a named nav, not a tablist that
 * promises panels it has none of"). So this is the same answer applied a
 * second time: a plain `nav` of real `Link`s, styled to read as a segmented
 * control, with `aria-current="page"` marking the active one instead of
 * `aria-selected` — real anchors, so ctrl/cmd-click and a screen reader's
 * link rotor both work, and no panel is ever implied.
 */
export function LibraryTabs() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const pending = useSuggestions('pending')
  const rejected = useSuggestions('rejected')
  const counts: Partial<Record<(typeof VIEWS)[number]['id'], number>> = {
    suggested: pending.data?.length,
    rejected: rejected.data?.length,
  }

  return (
    <nav
      aria-label={t('library.tabs.nav')}
      className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
    >
      {VIEWS.map((view) => {
        const active = isActive(pathname, view.path)
        const count = counts[view.id]
        return (
          <Link
            key={view.id}
            to={view.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium text-foreground/60 transition-colors hover:text-foreground',
              active && 'bg-background text-foreground shadow-sm',
            )}
          >
            {t(`library.tabs.${view.id}`)}
            {count !== undefined && <Badge variant="secondary">{count}</Badge>}
          </Link>
        )
      })}
    </nav>
  )
}
