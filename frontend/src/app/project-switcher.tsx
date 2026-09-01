import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useCurrentProject } from '@/features/projects'
import styles from './layout.module.scss'

/**
 * The open project, and a way to change it from anywhere.
 *
 * Only ready projects are offered: one still cloning has no checkout to work in,
 * so selecting it could only lead to a dead end.
 */
export function ProjectSwitcher() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { current, projects } = useCurrentProject()

  const selectable = projects.filter((p) => p.status === 'ready')

  if (selectable.length === 0 && !current) {
    return (
      <div className={styles.sidebarSection}>
        <span className={styles.sectionLabel}>{t('nav.project')}</span>
        <p className={styles.sectionEmpty}>{t('nav.noProjects')}</p>
      </div>
    )
  }

  return (
    <div className={styles.sidebarSection}>
      <span className={styles.sectionLabel}>{t('nav.project')}</span>
      <select
        className={styles.projectSelect}
        aria-label={t('nav.project')}
        value={current?.id ?? ''}
        onChange={(event) => {
          const id = event.target.value
          if (id) void navigate({ to: '/projects/$projectId', params: { projectId: id } })
        }}
      >
        {!current && <option value="">{t('nav.noneOpen')}</option>}
        {selectable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  )
}
