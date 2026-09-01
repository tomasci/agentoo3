import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, ConfirmDialog } from '@/shared/ui'
import { type Session, useDeleteSession } from '../hooks/use-sessions'
import styles from './sessions.module.scss'

export function SessionCard({ session, projectId }: { session: Session; projectId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const remove = useDeleteSession(projectId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <article className={styles.session}>
      <div className={styles.sessionHead}>
        <div>
          <h4 className={styles.sessionTitle}>
            <Link
              to="/projects/$projectId/sessions/$sessionId"
              params={{ projectId, sessionId: session.id }}
              className={styles.sessionLink}
            >
              {session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) })}
            </Link>
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
          <ActionsMenu
            label={t('sessions.actionsFor', { name: session.title ?? session.id.slice(0, 8) })}
            actions={[
              {
                id: 'open',
                label: t('sessions.open'),
                onSelect: () =>
                  void navigate({
                    to: '/projects/$projectId/sessions/$sessionId',
                    params: { projectId, sessionId: session.id },
                  }),
              },
              {
                id: 'delete',
                label: t('common.delete'),
                destructive: true,
                onSelect: () => setConfirmDelete(true),
              },
            ]}
          />
        </div>
      </div>

      {remove.isError && (
        <p className={styles.error}>{apiErrorMessage(remove.error, t('sessions.deleteFailed'))}</p>
      )}
      {session.lastError && <p className={styles.error}>{session.lastError}</p>}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('sessions.deleteTitle')}
        description={t('sessions.deleteConfirm')}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { id: session.id } }, { onSettled: () => setConfirmDelete(false) })
        }
      />
    </article>
  )
}
