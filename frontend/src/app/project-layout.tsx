import { Outlet, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
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
  const { data: projects, isPending } = useProjects()

  const project = projects?.find((p) => p.id === projectId)

  if (isPending) return <Spinner label={t('common.loading')} block />
  if (!project) return <Alert tone="danger">{t('projects.notFound')}</Alert>

  return <Outlet />
}
