import { useParams } from '@tanstack/react-router'
import { ProjectLibraryPage } from '@/features/library'
import { ProjectOverview, useProjects } from '@/features/projects'
import { ProjectSessions, SessionPage } from '@/features/sessions'

/** Thin adapters: the route supplies the id, the feature supplies the page. */
export function ProjectOverviewRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)
  return project ? <ProjectOverview project={project} /> : null
}

export function ProjectSessionsRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <ProjectSessions projectId={projectId} />
}

export function ProjectLibraryRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <ProjectLibraryPage projectId={projectId} />
}

export function SessionRoute() {
  const { projectId, sessionId } = useParams({ from: '/projects/$projectId/sessions/$sessionId' })
  return <SessionPage projectId={projectId} sessionId={sessionId} />
}
