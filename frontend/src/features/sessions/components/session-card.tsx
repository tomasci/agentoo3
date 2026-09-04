import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Alert,
  Badge,
  Card,
  Code,
  ConfirmDialog,
  type DefinitionItem,
  DefinitionList,
  Inline,
  Stack,
} from '@/shared/ui'
import { type Session, useDeleteSession } from '../hooks/use-sessions'
import styles from './sessions.module.scss'

export function SessionCard({ session, projectId }: { session: Session; projectId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const remove = useDeleteSession(projectId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const metaItems: DefinitionItem[] = [
    {
      id: 'workingDir',
      term: t('sessions.meta.workingDir'),
      description: <Code wrap>{session.workingDir}</Code>,
    },
    ...(session.branch
      ? [
          {
            id: 'branch',
            term: t('sessions.meta.branch'),
            description: <Code wrap>{session.branch}</Code>,
          },
        ]
      : []),
    ...(session.orchestrator
      ? [
          {
            id: 'orchestrator',
            term: t('sessions.meta.orchestrator'),
            description: <Code wrap>{session.orchestrator}</Code>,
          },
        ]
      : []),
  ]

  return (
    <Card as="article">
      <Stack gap={3}>
        <Inline justify="between" align="start" gap={3} wrap={false}>
          <h4 className={styles.sessionTitle}>
            <Link
              to="/projects/$projectId/sessions/$sessionId"
              params={{ projectId, sessionId: session.id }}
              className={styles.sessionLink}
            >
              {session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) })}
            </Link>
          </h4>

          <Inline gap={2} wrap={false}>
            <Badge variant="outline">{t(`sessions.status.${session.status}`)}</Badge>
            {/* Worth surfacing: a shared checkout means two sessions on this
                project would fight over the working tree. */}
            <Badge variant="outline" tone={session.isolated ? 'neutral' : 'warning'}>
              {session.isolated ? t('sessions.isolated') : t('sessions.shared')}
            </Badge>
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
          </Inline>
        </Inline>

        <DefinitionList items={metaItems} />

        {remove.isError && (
          <Alert tone="danger">{apiErrorMessage(remove.error, t('sessions.deleteFailed'))}</Alert>
        )}
        {session.lastError && <Alert tone="danger">{session.lastError}</Alert>}
      </Stack>

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
    </Card>
  )
}
