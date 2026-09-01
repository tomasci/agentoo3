import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { currentProjectIdAtom } from '@/shared/store/ui'
import { useProjects } from './use-projects'

/**
 * The project currently open, resolved against the server's list.
 *
 * The id is what gets persisted, not the project, so a rename or a status change
 * is picked up for free. A selection pointing at a project that no longer exists
 * — deleted here, or on another device — is cleared rather than left dangling.
 */
export function useCurrentProject() {
  const [currentProjectId, setCurrentProjectId] = useAtom(currentProjectIdAtom)
  const { data: projects, isPending } = useProjects()

  const current = projects?.find((p) => p.id === currentProjectId) ?? null

  useEffect(() => {
    // Only once the list has actually loaded: clearing on `undefined` would
    // drop the selection on every cold start.
    if (
      !isPending &&
      currentProjectId &&
      projects &&
      !projects.some((p) => p.id === currentProjectId)
    ) {
      setCurrentProjectId(null)
    }
  }, [currentProjectId, projects, isPending, setCurrentProjectId])

  return { current, currentProjectId, setCurrentProjectId, projects: projects ?? [] }
}
