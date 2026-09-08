import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Inline,
  PageHeader,
  Spinner,
  Stack,
  Textarea,
} from '@/shared/ui'
import {
  type IdeaComment,
  useCreateIdeaComment,
  useDeleteIdeaComment,
  useIdeaComments,
} from '../hooks/use-idea-comments'
import { formatIdeaDateTime } from './format'
import styles from './idea-comments.module.scss'

function CommentRow({ comment, ideaId }: { comment: IdeaComment; ideaId: string }) {
  const { t } = useTranslation()
  const remove = useDeleteIdeaComment(ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <li className={styles.comment}>
      <Inline justify="between" align="start" gap={2} wrap={false}>
        <span className={styles.commentMeta}>{formatIdeaDateTime(comment.createdAt)}</span>
        <Inline gap={2} wrap={false}>
          {comment.consumedAt && <Badge tone="neutral">{t('ideas.comments.consumed')}</Badge>}
          <ActionsMenu
            actions={[
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
      <p className={styles.commentBody}>{comment.body}</p>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ideas.comments.delete.title')}
        description={t('ideas.comments.delete.confirm')}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate({ path: { id: comment.id } }, { onSettled: () => setConfirmDelete(false) })
        }
      />
    </li>
  )
}

/**
 * The feedback thread a `verification`-column idea reads before clicking
 * continue: every unconsumed comment here is folded into the next follow-up
 * prompt (`useContinueIdea`/`useGenerateIdeaPrompt`'s own comment), and
 * `consumedAt` marks the ones already folded into an earlier one.
 */
export function IdeaComments({ ideaId }: { ideaId: string }) {
  const { t } = useTranslation()
  const comments = useIdeaComments(ideaId)
  const create = useCreateIdeaComment(ideaId)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const value = body.trim()
    if (!value) return
    setError(null)
    create.mutate(
      { path: { id: ideaId }, body: { body: value } },
      {
        onSuccess: () => setBody(''),
        onError: (e) => setError(apiErrorMessage(e, t('ideas.comments.addFailed'))),
      },
    )
  }

  return (
    <Card>
      <Stack gap={3}>
        <PageHeader level={2} title={t('ideas.comments.heading')} />

        {comments.isError && (
          <Alert tone="danger">
            {apiErrorMessage(comments.error, t('ideas.comments.loadFailed'))}
          </Alert>
        )}
        {comments.isPending && <Spinner label={t('common.loading')} block />}

        {!comments.isPending &&
          !comments.isError &&
          ((comments.data ?? []).length === 0 ? (
            <EmptyState size="sm" title={t('ideas.comments.empty')} />
          ) : (
            <ul className={styles.list}>
              {(comments.data ?? []).map((comment) => (
                <CommentRow key={comment.id} comment={comment} ideaId={ideaId} />
              ))}
            </ul>
          ))}

        <Stack gap={2}>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('ideas.comments.placeholder')}
            rows={2}
          />
          <Inline gap={2}>
            <Button type="button" disabled={create.isPending || !body.trim()} onClick={submit}>
              {create.isPending ? t('ideas.comments.adding') : t('ideas.comments.add')}
            </Button>
          </Inline>
          {error && <Alert tone="danger">{error}</Alert>}
        </Stack>
      </Stack>
    </Card>
  )
}
