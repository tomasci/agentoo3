import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui'
import { type Project, useDeleteProject } from '../hooks/use-projects'
import styles from './project-card.module.scss'
import { ProjectStatusBadge } from './project-status'
import { RecoveryPanel } from './recovery-panel'

export function ProjectCard({ project }: { project: Project }) {
  const { t } = useTranslation()
  const remove = useDeleteProject()

  const onDelete = () => {
    // A cloned project's files live under PROJECTS_DIR and we can remove them;
    // an adopted directory is the operator's own and the backend never deletes
    // it, so do not imply otherwise.
    const message =
      project.source === 'clone'
        ? t('projects.delete.confirmClone', { name: project.name })
        : t('projects.delete.confirmExisting', { name: project.name })
    if (!window.confirm(message)) return
    remove.mutate({
      path: { id: project.id },
      query: { removeFiles: project.source === 'clone' ? 'true' : 'false' },
    })
  }

  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.name}>{project.name}</h3>
          <dl className={styles.meta}>
            <div className={styles.row}>
              <dt>{t('projects.meta.path')}</dt>
              <dd>{project.path}</dd>
            </div>
            {project.remoteUrl && (
              <div className={styles.row}>
                <dt>{t('projects.meta.remote')}</dt>
                <dd>{project.remoteUrl}</dd>
              </div>
            )}
            {project.defaultBranch && (
              <div className={styles.row}>
                <dt>{t('projects.meta.branch')}</dt>
                <dd>{project.defaultBranch}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className={styles.right}>
          <ProjectStatusBadge project={project} />
          <Button type="button" onClick={onDelete} disabled={remove.isPending}>
            {t('common.delete')}
          </Button>
        </div>
      </div>

      {project.status === 'needs_manual' && <RecoveryPanel project={project} />}

      {project.status === 'failed' && project.lastError && (
        <p className={styles.error}>{project.lastError}</p>
      )}
    </article>
  )
}
