import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Button, ConfirmDialog } from '@/shared/ui'
import {
  type Project,
  useDeleteProject,
  useRetryProject,
  useUpdateProject,
} from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { isSshRemote } from '../lib/remote-url'
import styles from './project-overview.module.scss'
import { ProjectStatusBadge } from './project-status'
import { RecoveryPanel } from './recovery-panel'

/** The project's own page: what it is, how it authenticates, and how to remove it. */
export function ProjectOverview({ project }: { project: Project }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: sshKeys } = useSshKeys()
  const update = useUpdateProject()
  const retry = useRetryProject()
  const remove = useDeleteProject()

  const [keyId, setKeyId] = useState(project.sshKeyId ?? '')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Keep the select honest if the project changes under us — a poll, or the
  // recovery panel swapping the key.
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

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h2 className={styles.name}>{project.name}</h2>
        <ProjectStatusBadge project={project} />
      </div>

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>{t('projects.overview.details')}</h3>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>{t('projects.meta.path')}</dt>
            <dd>{project.path}</dd>
          </div>
          <div className={styles.fact}>
            <dt>{t('projects.overview.source')}</dt>
            <dd>{t(`projects.overview.source_${project.source}`)}</dd>
          </div>
          {project.remoteUrl && (
            <div className={styles.fact}>
              <dt>{t('projects.meta.remote')}</dt>
              <dd>{project.remoteUrl}</dd>
            </div>
          )}
          {project.defaultBranch && (
            <div className={styles.fact}>
              <dt>{t('projects.meta.branch')}</dt>
              <dd>{project.defaultBranch}</dd>
            </div>
          )}
        </dl>
      </section>

      {project.source === 'clone' && isSshRemote(project.remoteUrl) && (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>{t('projects.overview.authentication')}</h3>
          <div className={styles.row}>
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
            {update.isPending && <span className={styles.hint}>{t('projects.savingKey')}</span>}
            {saved && <span className={styles.saved}>{t('projects.keySaved')}</span>}
            {keyError && <span className={styles.error}>{keyError}</span>}
          </div>
          <p className={styles.hint}>{t('projects.keyRetryHint')}</p>
        </section>
      )}

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>{t('projects.overview.setup')}</h3>
        <div className={styles.row}>
          <Button
            type="button"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ path: { id: project.id } })}
          >
            {retry.isPending ? t('projects.recovery.checking') : t('projects.retry')}
          </Button>
          <span className={styles.hint}>{t('projects.overview.retryHint')}</span>
        </div>
        {project.status === 'failed' && project.lastError && (
          <p className={styles.error}>{project.lastError}</p>
        )}
        {project.status === 'needs_manual' && <RecoveryPanel project={project} />}
      </section>

      <section className={styles.dangerCard}>
        <h3 className={styles.dangerTitle}>{t('projects.overview.danger')}</h3>
        <p className={styles.hint}>
          {project.source === 'clone'
            ? t('projects.overview.deleteCloneHint')
            : t('projects.overview.deleteExistingHint')}
        </p>
        <div className={styles.row} style={{ marginTop: '0.75rem' }}>
          <Button type="button" onClick={() => setConfirmDelete(true)}>
            {t('projects.overview.deleteProject')}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('projects.delete.title')}
        description={
          project.source === 'clone'
            ? t('projects.delete.confirmClone', { name: project.name })
            : t('projects.delete.confirmExisting', { name: project.name })
        }
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            {
              path: { id: project.id },
              query: { removeFiles: project.source === 'clone' ? 'true' : 'false' },
            },
            { onSuccess: () => void navigate({ to: '/projects' }) },
          )
        }
      />
    </div>
  )
}
