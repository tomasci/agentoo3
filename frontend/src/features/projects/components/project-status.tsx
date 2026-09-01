import { useTranslation } from 'react-i18next'
import { isInFlight, type Project } from '../hooks/use-projects'
import styles from './project-status.module.scss'

export function ProjectStatusBadge({ project }: { project: Project }) {
  const { t } = useTranslation()
  return (
    <span className={styles.status}>
      <span
        className={`${styles.dot} ${styles[project.status]} ${isInFlight(project) ? styles.spin : ''}`}
        aria-hidden="true"
      />
      {t(`projects.status.${project.status}`)}
    </span>
  )
}
