import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, Markdown, PageHeader, StatusBadge } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Spinner } from '@/shared/ui/spinner'
import { useContinueIdea } from '../hooks/use-idea-continue'
import { useGenerateIdeaPrompt, useIdeaPrompts, useIdeaRuns } from '../hooks/use-idea-prompts'
import type { Idea } from '../hooks/use-ideas'
import { isIdeaBusy } from '../lib/status'
import { formatIdeaDateTime } from './format'

const PROMPT_STATUS_TONE = { pending: 'accent', ready: 'success', failed: 'danger' } as const
const RUN_STATUS_TONE = {
  generating: 'accent',
  dispatching: 'accent',
  running: 'accent',
  closed: 'neutral',
} as const
const RUN_OUTCOME_TONE = {
  finished: 'success',
  needs_attention: 'warning',
  interrupted: 'warning',
  superseded: 'neutral',
  session_deleted: 'danger',
} as const

/**
 * The generated prompt (and its history) plus the runs it produced, and the
 * one action that reads both: continue. Not split into two files — a prompt
 * and the run it fed into only make sense read side by side, and neither has
 * enough of its own concerns to earn a file on its own (contrast
 * `idea-canvas.tsx`/`idea-comments.tsx`/`idea-assets.tsx`, each with its own
 * create/edit/delete surface).
 */
export function IdeaPrompts({ idea, projectId }: { idea: Idea; projectId: string }) {
  const { t } = useTranslation()
  const prompts = useIdeaPrompts(idea.id)
  const runs = useIdeaRuns(idea.id)
  const generate = useGenerateIdeaPrompt(idea.id)
  const continueIdea = useContinueIdea(idea.id, projectId)
  const [genError, setGenError] = useState<string | null>(null)
  const [continueError, setContinueError] = useState<string | null>(null)

  const latest = prompts.data?.[0] ?? null
  const busy = isIdeaBusy(idea)

  const onGenerate = () => {
    setGenError(null)
    generate.mutate(
      { path: { id: idea.id }, body: { kind: latest?.kind ?? 'initial' } },
      { onError: (e) => setGenError(apiErrorMessage(e, t('ideas.prompts.generateFailed'))) },
    )
  }

  const onContinue = () => {
    setContinueError(null)
    continueIdea.mutate(
      { path: { id: idea.id } },
      { onError: (e) => setContinueError(apiErrorMessage(e, t('ideas.detail.continueFailed'))) },
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <PageHeader
            level={2}
            title={t('ideas.prompts.heading')}
            description={t('ideas.prompts.previewHint')}
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={generate.isPending || latest?.status === 'pending'}
                onClick={onGenerate}
              >
                {generate.isPending && <Spinner data-icon="inline-start" />}
                {generate.isPending || latest?.status === 'pending'
                  ? t('ideas.prompts.generating')
                  : latest
                    ? t('ideas.prompts.regenerate')
                    : t('ideas.prompts.generate')}
              </Button>
            }
          />

          {prompts.isError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(prompts.error, t('ideas.prompts.loadFailed'))}
              </AlertDescription>
            </Alert>
          )}
          {prompts.isPending && <Loading label={t('common.loading')} block />}
          {genError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{genError}</AlertDescription>
            </Alert>
          )}

          {!prompts.isPending && !prompts.isError && (prompts.data ?? []).length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('ideas.prompts.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!prompts.isPending && !prompts.isError && (prompts.data ?? []).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {(prompts.data ?? []).map((prompt) => (
                <li key={prompt.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{t(`ideas.prompts.kind.${prompt.kind}`)}</Badge>
                      <StatusBadge tone={PROMPT_STATUS_TONE[prompt.status]}>
                        {t(`ideas.prompts.status.${prompt.status}`)}
                      </StatusBadge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatIdeaDateTime(prompt.createdAt)}
                    </span>
                  </div>

                  {prompt.status === 'failed' && prompt.error && (
                    <Alert variant="destructive">
                      <CircleAlertIcon />
                      <AlertDescription>{prompt.error}</AlertDescription>
                    </Alert>
                  )}

                  {prompt.generatedText && <Markdown>{prompt.generatedText}</Markdown>}

                  {prompt.assumptions && prompt.assumptions.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t('ideas.prompts.assumptions')}
                      </span>
                      <ul className="m-0 list-disc pl-4 text-sm">
                        {prompt.assumptions.map((assumption, i) => (
                          // Plain strings with no id of their own — position
                          // is stable for a prompt that, once generated, this
                          // page never reorders.
                          // biome-ignore lint/suspicious/noArrayIndexKey: see above
                          <li key={i}>{assumption}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    {prompt.model && (
                      <span className="text-xs text-muted-foreground">
                        {t('ideas.prompts.model')}: {prompt.model}
                      </span>
                    )}
                    {prompt.costUsd != null && (
                      <span className="text-xs text-muted-foreground">
                        {t('ideas.prompts.cost')}: ${prompt.costUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <PageHeader level={2} title={t('ideas.runs.heading')} />

          {runs.isError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(runs.error, t('ideas.runs.loadFailed'))}
              </AlertDescription>
            </Alert>
          )}
          {runs.isPending && <Loading label={t('common.loading')} block />}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('ideas.runs.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {(runs.data ?? []).map((run) => (
                <li key={run.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{t(`ideas.prompts.kind.${run.kind}`)}</Badge>
                      <StatusBadge tone={RUN_STATUS_TONE[run.status]}>
                        {t(`ideas.runs.status.${run.status}`)}
                      </StatusBadge>
                      {run.outcome && (
                        <StatusBadge tone={RUN_OUTCOME_TONE[run.outcome]}>
                          {t(`ideas.runs.outcome.${run.outcome}`)}
                        </StatusBadge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatIdeaDateTime(run.startedAt)}
                    </span>
                  </div>
                  {run.detail && <Markdown>{run.detail}</Markdown>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {idea.status === 'verification' && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={busy || continueIdea.isPending} onClick={onContinue}>
                {continueIdea.isPending && <Spinner data-icon="inline-start" />}
                {continueIdea.isPending ? t('ideas.detail.continuing') : t('ideas.detail.continue')}
              </Button>
            </div>
            {continueError && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{continueError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
