import { useParams } from '@tanstack/react-router'
import { DockerPage } from '@/features/docker'
import { EditorLauncher } from '@/features/editor'
import { IdeaBoardPage, IdeaDetailPage } from '@/features/ideas'
import { ProjectLibraryPage } from '@/features/library'
import { ProjectOverview, ProjectPicker, useProjects } from '@/features/projects'
import { ProjectSessions, SessionPage } from '@/features/sessions'
import { projectTabId } from '@/shared/store/tabs'
import { useTabs } from './use-tabs'

/** Thin adapters: the route supplies the id, the feature supplies the page. */
export function ProjectOverviewRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const { data: projects } = useProjects()
  const { closeTab } = useTabs()
  const project = projects?.find((p) => p.id === projectId)

  // A deleted project has no tab worth keeping: closing it moves the reader to
  // a neighbouring tab rather than leaving them on a page about nothing.
  return project ? (
    <ProjectOverview project={project} onDeleted={() => closeTab(projectTabId(projectId))} />
  ) : null
}

export function ProjectSessionsRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <ProjectSessions projectId={projectId} />
}

export function ProjectLibraryRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <ProjectLibraryPage projectId={projectId} />
}

export function ProjectDockerRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <DockerPage projectId={projectId} />
}

export function ProjectIdeasRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  return <IdeaBoardPage projectId={projectId} />
}

export function IdeaDetailRoute() {
  const { projectId, ideaId } = useParams({ from: '/projects/$projectId/ideas/$ideaId' })
  return <IdeaDetailPage projectId={projectId} ideaId={ideaId} />
}

export function SessionRoute() {
  const { projectId, sessionId } = useParams({ from: '/projects/$projectId/sessions/$sessionId' })
  return <SessionPage projectId={projectId} sessionId={sessionId} />
}

export function SessionDockerRoute() {
  const { projectId, sessionId } = useParams({
    from: '/projects/$projectId/sessions/$sessionId/docker',
  })
  return <DockerPage projectId={projectId} sessionId={sessionId} />
}

export function SessionEditorRoute() {
  const { projectId, sessionId } = useParams({
    from: '/projects/$projectId/sessions/$sessionId/editor',
  })
  return <EditorLauncher projectId={projectId} sessionId={sessionId} />
}

/**
 * An empty tab: choose what it is for.
 *
 * Picking settles the project into this tab, which then becomes a project tab in
 * the same position — the tab you were filling in is the tab you end up in.
 */
export function NewTabRoute() {
  const { openProject } = useTabs()
  return <ProjectPicker onPick={(projectId) => openProject(projectId)} />
}
