import { useTranslation } from 'react-i18next'
import { useProjects } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { CreateProjectForm } from './create-project-form'
import { ProjectCard } from './project-card'
import styles from './projects-page.module.scss'

export function ProjectsPage() {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useProjects()
  const projects = data ?? []

  return (
    <div className={styles.page}>
      <CreateProjectForm />

      <div>
        <div className={styles.header}>
          <h2 className={styles.title}>{t('projects.heading')}</h2>
          {projects.length > 0 && (
            <span className={styles.count}>{t('projects.count', { count: projects.length })}</span>
          )}
        </div>

        {isError && (
          <p className={styles.problem}>
            {t('projects.loadFailed')} — {apiErrorMessage(error, t('projects.loadFailed'))}
          </p>
        )}

        {isPending && <p className={styles.empty}>{t('common.loading')}</p>}

        {!isPending && !isError && projects.length === 0 && (
          <p className={styles.empty}>{t('projects.empty')}</p>
        )}

        {projects.length > 0 && (
          <div className={styles.list}>
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
