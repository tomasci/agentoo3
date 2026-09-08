import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Alert, Badge, Card, Inline, Stack, StatusDot } from '@/shared/ui'
import type { Idea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUS_TONE, isIdeaBusy } from '../lib/status'
import { IdeaActionsMenu } from './idea-actions-menu'
import styles from './idea-board.module.scss'

/** Tone for the latest-prompt pill next to the status badge — the one piece
 * of `latestPrompt` the board's list DTO actually carries (`id`/`kind`/
 * `status`, not the `assumptions` text; see the report). `pending` gets the
 * same `accent` a busy idea already reads as elsewhere in this file. */
const PROMPT_TONE = { pending: 'accent', ready: 'success', failed: 'danger' } as const

export function IdeaCard({ idea, projectId }: { idea: Idea; projectId: string }) {
  const { t } = useTranslation()
  const busy = isIdeaBusy(idea)

  return (
    <Card as="article">
      <Stack gap={2}>
        <Inline justify="between" align="start" gap={2} wrap={false}>
          <h4 className={styles.cardTitle}>
            <Link
              to="/projects/$projectId/ideas/$ideaId"
              params={{ projectId, ideaId: idea.id }}
              className={styles.cardLink}
            >
              {idea.title}
            </Link>
          </h4>
          <IdeaActionsMenu idea={idea} projectId={projectId} showOpen />
        </Inline>

        <Inline gap={2}>
          <Badge tone={IDEA_STATUS_TONE[idea.status]}>{t(IDEA_STATUS_I18N_KEY[idea.status])}</Badge>
          {idea.latestPrompt && (
            <Badge tone={PROMPT_TONE[idea.latestPrompt.status]} variant="outline">
              {t(`ideas.prompts.status.${idea.latestPrompt.status}`)}
            </Badge>
          )}
          {busy && (
            <Inline gap={1} wrap={false}>
              <StatusDot tone="accent" pulse />
              <span className={styles.busyLabel}>{t('common.working')}</span>
            </Inline>
          )}
        </Inline>

        <Inline gap={3}>
          <span className={styles.counts}>
            {t('ideas.board.blocks', { count: idea.blockCount })}
          </span>
          <span className={styles.counts}>
            {t('ideas.board.comments', { count: idea.commentCount })}
          </span>
          <span className={styles.counts}>
            {t('ideas.board.assets', { count: idea.assetCount })}
          </span>
        </Inline>

        {idea.lastError && (
          <Alert tone="danger" title={t('ideas.board.stuckReason')}>
            {idea.lastError}
          </Alert>
        )}
      </Stack>
    </Card>
  )
}
