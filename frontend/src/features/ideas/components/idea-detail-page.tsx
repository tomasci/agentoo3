import { Link, useNavigate } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader, StatusBadge } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { buttonVariants } from '@/shared/ui/button'
import { useIdea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUS_TONE } from '../lib/status'
import { IdeaActionsMenu } from './idea-actions-menu'
import { IdeaAssets } from './idea-assets'
import { IdeaCanvas } from './idea-canvas'
import { IdeaComments } from './idea-comments'
import { IdeaPrompts } from './idea-prompts'
import { IdeaSettingsDialog } from './idea-settings-dialog'

export function IdeaDetailPage({ projectId, ideaId }: { projectId: string; ideaId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const idea = useIdea(ideaId)

  if (idea.isPending) return <Loading label={t('common.loading')} block />
  if (idea.isError || !idea.data) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertDescription>{apiErrorMessage(idea.error, t('ideas.notFound'))}</AlertDescription>
      </Alert>
    )
  }

  const data = idea.data

  return (
    // `--idea-canvas-height` is this page's own viewport budget for
    // `IdeaCanvas`'s explorer pane and `IdeaFlowCanvas`'s spatial surface
    // beneath it (both read it with a `32rem` fallback of their own, for
    // whichever of their tests mounts either standalone): 18rem covers
    // `.body`'s own top/bottom padding, this header and the gap under it,
    // `IdeaCanvas`'s own heading, and the shell's status bar, leaving a
    // remainder so the next section's top edge peeks above the fold — the
    // only affordance that there is more below, since React Flow keeps
    // `preventScrolling` on and a wheel over the canvas never scrolls the
    // page itself. Reads `--shell-height` (published by `app/use-visual-
    // viewport.ts` from `window.visualViewport`) rather than bare `100dvh`
    // for the same reason the app shell itself does: an open on-screen
    // keyboard shrinks the usable viewport the same way it shrinks the shell.
    <div className="grid grid-cols-1 gap-5 [--idea-canvas-height:max(24rem,calc(var(--shell-height,100dvh)-18rem))]">
      <PageHeader
        title={data.title}
        eyebrow={
          <StatusBadge tone={IDEA_STATUS_TONE[data.status]}>
            {t(IDEA_STATUS_I18N_KEY[data.status])}
          </StatusBadge>
        }
        actions={
          <>
            {data.sessionId && (
              <Link
                to="/projects/$projectId/sessions/$sessionId"
                params={{ projectId, sessionId: data.sessionId }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('ideas.detail.viewSession')}
              </Link>
            )}
            <Link
              to="/projects/$projectId/ideas"
              params={{ projectId }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('ideas.detail.backToBoard')}
            </Link>
            <IdeaSettingsDialog idea={data} projectId={projectId} />
            <IdeaActionsMenu
              idea={data}
              projectId={projectId}
              showOpen={false}
              onDeleted={() =>
                void navigate({ to: '/projects/$projectId/ideas', params: { projectId } })
              }
            />
          </>
        }
      />

      {data.lastError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('ideas.board.stuckReason')}</AlertTitle>
          <AlertDescription>{data.lastError}</AlertDescription>
        </Alert>
      )}

      <IdeaCanvas ideaId={ideaId} />
      <IdeaAssets ideaId={ideaId} />
      <IdeaComments ideaId={ideaId} />
      <IdeaPrompts idea={data} projectId={projectId} />
    </div>
  )
}
