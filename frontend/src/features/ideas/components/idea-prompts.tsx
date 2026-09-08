import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Inline,
  Markdown,
  PageHeader,
  Spinner,
  Stack,
} from '@/shared/ui'
import { useContinueIdea } from '../hooks/use-idea-continue'
import { useGenerateIdeaPrompt, useIdeaPrompts, useIdeaRuns } from '../hooks/use-idea-prompts'
import type { Idea } from '../hooks/use-ideas'
import { isIdeaBusy } from '../lib/status'
import { formatIdeaDateTime } from './format'
import styles from './idea-prompts.module.scss'

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
    <Stack gap={5}>
      <Card>
        <Stack gap={3}>
          <PageHeader
            level={2}
            title={t('ideas.prompts.heading')}
            actions={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={generate.isPending || latest?.status === 'pending'}
                onClick={onGenerate}
              >
                {generate.isPending || latest?.status === 'pending'
                  ? t('ideas.prompts.generating')
                  : latest
                    ? t('ideas.prompts.regenerate')
                    : t('ideas.prompts.generate')}
              </Button>
            }
          />

          {prompts.isError && (
            <Alert tone="danger">
              {apiErrorMessage(prompts.error, t('ideas.prompts.loadFailed'))}
            </Alert>
          )}
          {prompts.isPending && <Spinner label={t('common.loading')} block />}
          {genError && <Alert tone="danger">{genError}</Alert>}

          {!prompts.isPending && !prompts.isError && (prompts.data ?? []).length === 0 && (
            <EmptyState size="sm" title={t('ideas.prompts.empty')} />
          )}

          {!prompts.isPending && !prompts.isError && (prompts.data ?? []).length > 0 && (
            <ul className={styles.list}>
              {(prompts.data ?? []).map((prompt) => (
                <li key={prompt.id} className={styles.entry}>
                  <Inline justify="between" gap={2}>
                    <Inline gap={2}>
                      <Badge tone="neutral" variant="outline">
                        {t(`ideas.prompts.kind.${prompt.kind}`)}
                      </Badge>
                      <Badge tone={PROMPT_STATUS_TONE[prompt.status]}>
                        {t(`ideas.prompts.status.${prompt.status}`)}
                      </Badge>
                    </Inline>
                    <span className={styles.entryMeta}>{formatIdeaDateTime(prompt.createdAt)}</span>
                  </Inline>

                  {prompt.status === 'failed' && prompt.error && (
                    <Alert tone="danger">{prompt.error}</Alert>
                  )}

                  {prompt.generatedText && <Markdown>{prompt.generatedText}</Markdown>}

                  {prompt.assumptions && prompt.assumptions.length > 0 && (
                    <Stack gap={1}>
                      <span className={styles.entryMeta}>{t('ideas.prompts.assumptions')}</span>
                      <ul className={styles.assumptions}>
                        {prompt.assumptions.map((assumption, i) => (
                          // Plain strings with no id of their own — position
                          // is stable for a prompt that, once generated, this
                          // page never reorders.
                          // biome-ignore lint/suspicious/noArrayIndexKey: see above
                          <li key={i}>{assumption}</li>
                        ))}
                      </ul>
                    </Stack>
                  )}

                  <Inline gap={3}>
                    {prompt.model && (
                      <span className={styles.entryMeta}>
                        {t('ideas.prompts.model')}: {prompt.model}
                      </span>
                    )}
                    {prompt.costUsd != null && (
                      <span className={styles.entryMeta}>
                        {t('ideas.prompts.cost')}: ${prompt.costUsd.toFixed(4)}
                      </span>
                    )}
                  </Inline>
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Card>

      <Card>
        <Stack gap={3}>
          <PageHeader level={2} title={t('ideas.runs.heading')} />

          {runs.isError && (
            <Alert tone="danger">{apiErrorMessage(runs.error, t('ideas.runs.loadFailed'))}</Alert>
          )}
          {runs.isPending && <Spinner label={t('common.loading')} block />}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length === 0 && (
            <EmptyState size="sm" title={t('ideas.runs.empty')} />
          )}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length > 0 && (
            <ul className={styles.list}>
              {(runs.data ?? []).map((run) => (
                <li key={run.id} className={styles.entry}>
                  <Inline justify="between" gap={2}>
                    <Inline gap={2}>
                      <Badge tone="neutral" variant="outline">
                        {t(`ideas.prompts.kind.${run.kind}`)}
                      </Badge>
                      <Badge tone={RUN_STATUS_TONE[run.status]}>
                        {t(`ideas.runs.status.${run.status}`)}
                      </Badge>
                      {run.outcome && (
                        <Badge tone={RUN_OUTCOME_TONE[run.outcome]} variant="outline">
                          {t(`ideas.runs.outcome.${run.outcome}`)}
                        </Badge>
                      )}
                    </Inline>
                    <span className={styles.entryMeta}>{formatIdeaDateTime(run.startedAt)}</span>
                  </Inline>
                  {run.detail && <p className={styles.entryMeta}>{run.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Card>

      {idea.status === 'verification' && (
        <Card>
          <Stack gap={3}>
            <Inline gap={3}>
              <Button type="button" disabled={busy || continueIdea.isPending} onClick={onContinue}>
                {continueIdea.isPending ? t('ideas.detail.continuing') : t('ideas.detail.continue')}
              </Button>
            </Inline>
            {continueError && <Alert tone="danger">{continueError}</Alert>}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}
