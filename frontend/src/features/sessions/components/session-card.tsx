import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Code,
  ConfirmDialog,
  type DefinitionItem,
  DefinitionList,
  StatusBadge,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { type Session, useDeleteSession } from '../hooks/use-sessions'

export function SessionCard({ session, projectId }: { session: Session; projectId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const remove = useDeleteSession(projectId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Shared by the title link's visible text and its `title` attribute (the
  // full name, reachable even once the visible text is clipped), so the two
  // can never drift from each other.
  const displayTitle = session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) })

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
    ...(session.baseBranch
      ? [
          {
            id: 'baseBranch',
            term: t('sessions.meta.baseBranch'),
            description: <Code wrap>{session.baseBranch}</Code>,
          },
        ]
      : []),
    ...(session.baseSha
      ? [
          {
            id: 'baseSha',
            // Convention, not this session's choice: 7 characters is what git
            // itself abbreviates a sha to.
            term: t('sessions.meta.baseSha'),
            description: <Code>{session.baseSha.slice(0, 7)}</Code>,
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
    // A real `<article>` around `Card`: the new `Card` (unlike the old
    // wrapper) is always a `<div>` with no polymorphic `as` prop, and one
    // session among several in a list still earns its own landmark.
    <article>
      <Card>
        <CardHeader>
          <CardTitle className="min-w-0">
            {/* `block`, not just `truncate`: a `Link` renders an inline `<a>`,
                and `text-overflow: ellipsis` has no effect on an inline box, so
                the title kept its full min-content width and ran under the
                badges instead of eliding. `title` keeps the full name reachable
                once the visible text is clipped. */}
            <Link
              to="/projects/$projectId/sessions/$sessionId"
              params={{ projectId, sessionId: session.id }}
              className="block truncate text-inherit no-underline hover:text-primary hover:underline"
              title={displayTitle}
            >
              {displayTitle}
            </Link>
          </CardTitle>
          <CardAction className="shrink-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{t(`sessions.status.${session.status}`)}</Badge>
              {/* Worth surfacing: a shared checkout means two sessions on this
                  project would fight over the working tree. */}
              <StatusBadge tone={session.isolated ? 'neutral' : 'warning'}>
                {session.isolated ? t('sessions.isolated') : t('sessions.shared')}
              </StatusBadge>
              <ActionsMenu
                label={t('sessions.actionsFor', {
                  name: session.title ?? session.id.slice(0, 8),
                })}
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
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <DefinitionList items={metaItems} />

            {/* The one case this field exists for: the worktree could not be
                refreshed before the session started, so it may be behind. */}
            {session.baseNote && (
              <Alert role="status">
                <AlertDescription>{session.baseNote}</AlertDescription>
              </Alert>
            )}

            {remove.isError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {apiErrorMessage(remove.error, t('sessions.deleteFailed'))}
                </AlertDescription>
              </Alert>
            )}
            {session.lastError && (
              <Alert variant="destructive">
                <AlertDescription>{session.lastError}</AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

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
