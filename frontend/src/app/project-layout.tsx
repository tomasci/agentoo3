import { Outlet, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentProject, useProjects } from '@/features/projects'

/**
 * Wraps every page under /projects/$projectId.
 *
 * Selecting the project lives here rather than in each page, so the selection
 * cannot fall out of step with the URL depending on which sub-page you landed on.
 */
export function ProjectLayout() {
  const { t } = useTranslation()
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const { setCurrentProjectId } = useCurrentProject()
  const { data: projects, isPending } = useProjects()

  useEffect(() => {
    setCurrentProjectId(projectId)
  }, [projectId, setCurrentProjectId])

  const project = projects?.find((p) => p.id === projectId)

  if (isPending) return <p>{t('common.loading')}</p>
  if (!project) return <p>{t('projects.notFound')}</p>

  return <Outlet />
}
