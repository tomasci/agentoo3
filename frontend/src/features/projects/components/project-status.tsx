import { useTranslation } from 'react-i18next'
import { StatusBadge, type Tone } from '@/shared/components'
import { isInFlight, type Project, type ProjectStatus } from '../hooks/use-projects'

// A `Record<ProjectStatus, Tone>`, not a lookup that types as `string |
// undefined` under `noUncheckedIndexedAccess`: this fails the build instead
// of silently rendering with no colour if the API's status union ever grows
// a member this file doesn't know about.
const TONE: Record<ProjectStatus, Tone> = {
  pending: 'accent',
  cloning: 'accent',
  ready: 'success',
  needs_manual: 'warning',
  failed: 'danger',
}

export function ProjectStatusBadge({ project }: { project: Project }) {
  const { t } = useTranslation()
  const tone = TONE[project.status]

  return (
    <StatusBadge tone={tone} pulse={isInFlight(project)}>
      {t(`projects.status.${project.status}`)}
    </StatusBadge>
  )
}
