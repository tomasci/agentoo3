import { useTranslation } from 'react-i18next'
import { Badge, StatusDot, type Tone } from '@/shared/ui'
import { isInFlight, type Project, type ProjectStatus } from '../hooks/use-projects'
import styles from './project-status.module.scss'

// A `Record<ProjectStatus, Tone>`, not `styles[project.status]` indexing into
// an SCSS module: the old form typed as `string | undefined` under
// `noUncheckedIndexedAccess` and silently rendered with no colour at all if
// the API's status union ever grew a member this file didn't know about. This
// fails the build instead.
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
    <Badge tone={tone}>
      {/* Badge lays out its children with no gap of its own — spacing between
          the dot and the label is this file's job, not Badge's. */}
      <span className={styles.content}>
        <StatusDot tone={tone} pulse={isInFlight(project)} />
        {t(`projects.status.${project.status}`)}
      </span>
    </Badge>
  )
}
