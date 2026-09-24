import { Outlet, useLocation, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import { isBareShellPath } from '@/shared/store/tabs'
import { Alert, Spinner } from '@/shared/ui'

/**
 * Wraps every page under /projects/$projectId.
 *
 * The lookup lives here rather than in each page, so a project that has been
 * deleted or was never there says so once, instead of each sub-page finding out
 * on its own. Which project is *open* is no longer a question this layout
 * answers — the tab in the URL is the answer.
 */
export function ProjectLayout() {
  const { t } = useTranslation()
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const { pathname } = useLocation()
  const { data: projects, isPending } = useProjects()

  // The standalone editor launcher (shared/store/tabs.ts's `isBareShellPath`)
  // is a child of this route too, but this lookup must not gate it the way it
  // gates every ordinary page: the launcher already tells an unknown
  // project/session apart from a healthy one through its own status GET (a
  // 404 there becomes its own message and its own back link), so making it
  // wait on *this* lookup first only bought a second, off-centre "Loading…"
  // above the launcher's own centred one, and — for a project this list
  // genuinely doesn't have — this layout's alert with no way back, in place
  // of the launcher's own. `useProjects` is still called unconditionally
  // above (rules of hooks); this just skips acting on it.
  if (isBareShellPath(pathname)) return <Outlet />

  const project = projects?.find((p) => p.id === projectId)

  if (isPending) return <Spinner label={t('common.loading')} block />
  if (!project) return <Alert tone="danger">{t('projects.notFound')}</Alert>

  return <Outlet />
}
