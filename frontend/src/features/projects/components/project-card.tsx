import { useAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { routeAtom } from '@/shared/store/ui'
import { Button } from '@/shared/ui'
import {
  type Project,
  useDeleteProject,
  useRetryProject,
  useUpdateProject,
} from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { isSshRemote } from '../lib/remote-url'
import styles from './project-card.module.scss'
import { ProjectStatusBadge } from './project-status'
import { RecoveryPanel } from './recovery-panel'

export function ProjectCard({ project }: { project: Project }) {
  const { t } = useTranslation()
  const remove = useDeleteProject()
  const update = useUpdateProject()
  const retry = useRetryProject()
  const { data: sshKeys } = useSshKeys()
  const [, setRoute] = useAtom(routeAtom)
  const [keyId, setKeyId] = useState(project.sshKeyId ?? '')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Keep the select honest if the project changes under us (a poll, or the
  // recovery panel swapping the key).
  useEffect(() => {
    setKeyId(project.sshKeyId ?? '')
  }, [project.sshKeyId])

  const changeKey = (next: string) => {
    setKeyId(next)
    setKeyError(null)
    setSaved(false)
    update.mutate(
      { path: { id: project.id }, body: { sshKeyId: next || null } },
      {
        onSuccess: () => {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        },
        onError: (error) => setKeyError(apiErrorMessage(error, t('projects.keyChangeFailed'))),
      },
    )
  }

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
          {/* Only a ready project has a checkout to run a session against. */}
          <Button
            type="button"
            disabled={project.status !== 'ready'}
            onClick={() => setRoute({ name: 'project', projectId: project.id })}
          >
            {t('projects.open')}
          </Button>
          <Button type="button" onClick={onDelete} disabled={remove.isPending}>
            {t('common.delete')}
          </Button>
        </div>
      </div>

      {/* Always available, not only on failure: the key is the thing you most
          often discover you got wrong, and re-creating the project to change it
          would be absurd. */}
      {project.source === 'clone' && isSshRemote(project.remoteUrl) && (
        <div className={styles.keyRow}>
          <span>{t('projects.form.sshKey')}</span>
          <select
            className={styles.select}
            value={keyId}
            onChange={(e) => changeKey(e.target.value)}
            disabled={update.isPending}
            aria-label={t('projects.form.sshKey')}
          >
            <option value="">{t('projects.form.sshKeyNone')}</option>
            {(sshKeys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
                {k.comment ? ` — ${k.comment}` : ''}
              </option>
            ))}
          </select>
          {update.isPending && <span>{t('projects.savingKey')}</span>}
          {saved && <span className={styles.saved}>{t('projects.keySaved')}</span>}
          {keyError && <span className={styles.error}>{keyError}</span>}

          {/* The retry the hint refers to. It previously pointed at a button
              that only existed on the failure panel. */}
          <Button
            type="button"
            disabled={retry.isPending || update.isPending}
            onClick={() => retry.mutate({ path: { id: project.id } })}
          >
            {retry.isPending ? t('projects.recovery.checking') : t('projects.retry')}
          </Button>
          <span>{t('projects.keyRetryHint')}</span>
        </div>
      )}

      {project.status === 'needs_manual' && <RecoveryPanel project={project} />}

      {project.status === 'failed' && project.lastError && (
        <p className={styles.error}>{project.lastError}</p>
      )}
    </article>
  )
}
