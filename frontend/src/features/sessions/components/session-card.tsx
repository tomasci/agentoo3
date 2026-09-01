import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
import { type Session, useDeleteSession } from '../hooks/use-sessions'
import styles from './sessions.module.scss'

export function SessionCard({ session, projectId }: { session: Session; projectId: string }) {
  const { t } = useTranslation()
  const remove = useDeleteSession(projectId)

  return (
    <article className={styles.session}>
      <div className={styles.sessionHead}>
        <div>
          <h4 className={styles.sessionTitle}>
            {session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) })}
          </h4>
          <dl className={styles.meta}>
            <div className={styles.metaRow}>
              <dt>{t('sessions.meta.workingDir')}</dt>
              <dd>{session.workingDir}</dd>
            </div>
            {session.branch && (
              <div className={styles.metaRow}>
                <dt>{t('sessions.meta.branch')}</dt>
                <dd>{session.branch}</dd>
              </div>
            )}
            {session.orchestrator && (
              <div className={styles.metaRow}>
                <dt>{t('sessions.meta.orchestrator')}</dt>
                <dd>{session.orchestrator}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className={styles.badges}>
          <span className={styles.badge}>{t(`sessions.status.${session.status}`)}</span>
          {/* Worth surfacing: a shared checkout means two sessions on this
              project would fight over the working tree. */}
          <span className={`${styles.badge} ${session.isolated ? '' : styles.shared}`}>
            {session.isolated ? t('sessions.isolated') : t('sessions.shared')}
          </span>
          <Button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              if (!window.confirm(t('sessions.deleteConfirm'))) return
              remove.mutate({ path: { id: session.id } })
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>

      {remove.isError && (
        <p className={styles.error}>{apiErrorMessage(remove.error, t('sessions.deleteFailed'))}</p>
      )}
      {session.lastError && <p className={styles.error}>{session.lastError}</p>}
    </article>
  )
}
