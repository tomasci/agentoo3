import { Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Alert, Badge, Button, PageHeader, Spinner } from '@/shared/ui'
import { useIdea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUS_TONE } from '../lib/status'
import { IdeaActionsMenu } from './idea-actions-menu'
import { IdeaAssets } from './idea-assets'
import { IdeaCanvas } from './idea-canvas'
import { IdeaComments } from './idea-comments'
import styles from './idea-detail-page.module.scss'
import { IdeaPrompts } from './idea-prompts'
import { IdeaSettingsDialog } from './idea-settings-dialog'

export function IdeaDetailPage({ projectId, ideaId }: { projectId: string; ideaId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const idea = useIdea(ideaId)

  if (idea.isPending) return <Spinner label={t('common.loading')} block />
  if (idea.isError || !idea.data) {
    return <Alert tone="danger">{apiErrorMessage(idea.error, t('ideas.notFound'))}</Alert>
  }

  const data = idea.data

  return (
    <div className={styles.page}>
      <PageHeader
        title={data.title}
        eyebrow={
          <Badge tone={IDEA_STATUS_TONE[data.status]}>{t(IDEA_STATUS_I18N_KEY[data.status])}</Badge>
        }
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <Link to="/projects/$projectId/ideas" params={{ projectId }}>
                {t('ideas.detail.backToBoard')}
              </Link>
            </Button>
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
        <Alert tone="danger" title={t('ideas.board.stuckReason')}>
          {data.lastError}
        </Alert>
      )}

      <IdeaCanvas ideaId={ideaId} />
      <IdeaAssets ideaId={ideaId} />
      <IdeaComments ideaId={ideaId} />
      <IdeaPrompts idea={data} projectId={projectId} />
    </div>
  )
}
