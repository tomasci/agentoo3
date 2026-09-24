import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, ConfirmDialog, Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Item, ItemActions, ItemContent, ItemGroup, ItemHeader } from '@/shared/ui/item'
import { Textarea } from '@/shared/ui/textarea'
import {
  type IdeaComment,
  useCreateIdeaComment,
  useDeleteIdeaComment,
  useIdeaComments,
} from '../hooks/use-idea-comments'
import { formatIdeaDateTime } from './format'

function CommentRow({ comment, ideaId }: { comment: IdeaComment; ideaId: string }) {
  const { t } = useTranslation()
  const remove = useDeleteIdeaComment(ideaId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemHeader>
          <span className="text-xs text-muted-foreground">
            {formatIdeaDateTime(comment.createdAt)}
          </span>
          {comment.consumedAt && <Badge variant="outline">{t('ideas.comments.consumed')}</Badge>}
        </ItemHeader>
        <p className="whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>
      </ItemContent>
      <ItemActions className="self-start">
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
      </ItemActions>

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
    </Item>
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
      <CardContent className="flex flex-col gap-3">
        <PageHeader level={2} title={t('ideas.comments.heading')} />

        {comments.isError && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {apiErrorMessage(comments.error, t('ideas.comments.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {comments.isPending && <Loading label={t('common.loading')} block />}

        {!comments.isPending &&
          !comments.isError &&
          ((comments.data ?? []).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('ideas.comments.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {(comments.data ?? []).map((comment) => (
                <CommentRow key={comment.id} comment={comment} ideaId={ideaId} />
              ))}
            </ItemGroup>
          ))}

        <div className="flex flex-col gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('ideas.comments.placeholder')}
            rows={2}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={create.isPending || !body.trim()} onClick={submit}>
              {create.isPending ? t('ideas.comments.adding') : t('ideas.comments.add')}
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
