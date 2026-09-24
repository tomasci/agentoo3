import { Link } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusBadge, StatusDot } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Card, CardContent } from '@/shared/ui/card'
import type { Idea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUS_TONE, isIdeaBusy } from '../lib/status'
import { IdeaActionsMenu } from './idea-actions-menu'

/** Tone for the latest-prompt pill next to the status badge — the one piece
 * of `latestPrompt` the board's list DTO actually carries (`id`/`kind`/
 * `status`, not the `assumptions` text; see the report). `pending` gets the
 * same `accent` a busy idea already reads as elsewhere in this file. */
const PROMPT_TONE = { pending: 'accent', ready: 'success', failed: 'danger' } as const

export function IdeaCard({ idea, projectId }: { idea: Idea; projectId: string }) {
  const { t } = useTranslation()
  const busy = isIdeaBusy(idea)

  return (
    // `Card` renders a fixed `<div>` — it has no polymorphic `as`/`render`
    // slot the way the old wrapper did — so the sectioning element every
    // other card on the board still needs is wrapped around it instead.
    <article>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-nowrap items-start justify-between gap-2">
            <h4 className="m-0 text-base font-semibold">
              <Link
                to="/projects/$projectId/ideas/$ideaId"
                params={{ projectId, ideaId: idea.id }}
                className="rounded-sm text-foreground no-underline transition-colors hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {idea.title}
              </Link>
            </h4>
            <IdeaActionsMenu idea={idea} projectId={projectId} showOpen />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={IDEA_STATUS_TONE[idea.status]}>
              {t(IDEA_STATUS_I18N_KEY[idea.status])}
            </StatusBadge>
            {idea.latestPrompt && (
              <StatusBadge tone={PROMPT_TONE[idea.latestPrompt.status]}>
                {t(`ideas.prompts.status.${idea.latestPrompt.status}`)}
              </StatusBadge>
            )}
            {busy && (
              <span className="flex flex-nowrap items-center gap-1">
                <StatusDot tone="accent" pulse />
                <span className="text-xs text-muted-foreground">{t('common.working')}</span>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t('ideas.board.blocks', { count: idea.blockCount })}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('ideas.board.comments', { count: idea.commentCount })}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('ideas.board.assets', { count: idea.assetCount })}
            </span>
          </div>

          {idea.lastError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>{t('ideas.board.stuckReason')}</AlertTitle>
              <AlertDescription>{idea.lastError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </article>
  )
}
