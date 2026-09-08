import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  NumberInput,
  PageHeader,
  Select,
  type SelectOption,
  Spinner,
  Stack,
  toast,
} from '@/shared/ui'
import { type Idea, useIdea, useUpdateIdea } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUS_TONE } from '../lib/status'
import { type UpdateIdeaFormValues, updateIdeaFormSchema } from '../model/idea-form.schema'
import { IdeaActionsMenu } from './idea-actions-menu'
import { IdeaAssets } from './idea-assets'
import { IdeaCanvas } from './idea-canvas'
import { IdeaComments } from './idea-comments'
import styles from './idea-detail-page.module.scss'
import { IdeaPrompts } from './idea-prompts'

/**
 * Orchestrator, base branch and budget: chosen up front, on the card, since
 * the session those fields describe is not created until handoff — this is
 * the one place to change them before that happens. `title` rides along in
 * the same save rather than getting an inline-edit of its own, matching
 * `AgentEditorPage`'s one-form-one-save shape for the identical kind of page.
 */
function IdeaSettingsForm({ idea, projectId }: { idea: Idea; projectId: string }) {
  const { t } = useTranslation()
  const { data: agents } = useAgents()
  const update = useUpdateIdea(projectId)
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<UpdateIdeaFormValues>({
    resolver: zodResolver(updateIdeaFormSchema),
    defaultValues: {
      title: idea.title,
      orchestrator: idea.orchestrator,
      baseBranch: idea.baseBranch,
      maxBudgetUsd: idea.maxBudgetUsd,
    },
  })

  // Keyed on the id alone, not the whole (polling) `idea` row: `useIdea`
  // (hooks/use-ideas.ts) refetches every 1.5s while the idea is busy, and
  // resetting on every one of those would overwrite whatever the reader is
  // mid-typing here. Re-seeding only when the reader lands on a *different*
  // idea is the trade a settings form open on a live-polled row has to make.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    reset({
      title: idea.title,
      orchestrator: idea.orchestrator,
      baseBranch: idea.baseBranch,
      maxBudgetUsd: idea.maxBudgetUsd,
    })
  }, [idea.id])

  const fieldError = (message?: string) => (message ? t(message) : undefined)

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  const orchestratorOptions: SelectOption[] = [
    { value: '', label: t('ideas.form.orchestratorNone') },
    ...orchestrators.map((a) => ({ value: a.name, label: a.name, description: a.description })),
  ]

  const onSubmit = (values: UpdateIdeaFormValues) => {
    setServerError(null)
    update.mutate(
      {
        path: { id: idea.id },
        body: {
          title: values.title,
          orchestrator: values.orchestrator || null,
          baseBranch: values.baseBranch?.trim() ? values.baseBranch.trim() : null,
          maxBudgetUsd: values.maxBudgetUsd ?? null,
        },
      },
      {
        onSuccess: () => toast({ title: t('ideas.detail.settingsSaved') }),
        onError: (e) => setServerError(apiErrorMessage(e, t('ideas.form.updateFailed'))),
      },
    )
  }

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className={styles.form}>
          <Stack gap={3}>
            <PageHeader level={2} title={t('ideas.detail.settingsHeading')} />

            <Field label={t('ideas.form.title')} error={fieldError(errors.title?.message)}>
              <Input {...register('title')} />
            </Field>

            <Field
              label={t('ideas.form.orchestrator')}
              hint={
                orchestrators.length === 0
                  ? t('ideas.form.orchestratorEmpty')
                  : t('ideas.form.orchestratorHint')
              }
              error={fieldError(errors.orchestrator?.message)}
            >
              <Controller
                control={control}
                name="orchestrator"
                render={({ field }) => (
                  <Select
                    options={orchestratorOptions}
                    value={field.value ?? ''}
                    onValueChange={(value) => field.onChange(value || null)}
                    name={field.name}
                    ref={field.ref}
                  />
                )}
              />
            </Field>

            <Field
              label={t('ideas.form.baseBranch')}
              hint={t('ideas.form.baseBranchHint')}
              error={fieldError(errors.baseBranch?.message)}
            >
              <Input mono {...register('baseBranch')} />
            </Field>

            <Field
              label={t('ideas.form.budget')}
              hint={t('ideas.form.budgetHint')}
              error={fieldError(errors.maxBudgetUsd?.message)}
            >
              <Controller
                control={control}
                name="maxBudgetUsd"
                render={({ field }) => (
                  <NumberInput
                    value={field.value}
                    onValueChange={(value) => field.onChange(value)}
                    min={1}
                    max={1000}
                    name={field.name}
                  />
                )}
              />
            </Field>

            <div>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? t('ideas.form.saving') : t('ideas.form.saveChanges')}
              </Button>
            </div>

            {serverError && <Alert tone="danger">{serverError}</Alert>}
          </Stack>
        </div>
      </form>
    </Card>
  )
}

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
      <div>
        <Button asChild variant="secondary">
          <Link to="/projects/$projectId/ideas" params={{ projectId }}>
            {t('ideas.detail.backToBoard')}
          </Link>
        </Button>
      </div>

      <PageHeader
        title={data.title}
        eyebrow={
          <Badge tone={IDEA_STATUS_TONE[data.status]}>{t(IDEA_STATUS_I18N_KEY[data.status])}</Badge>
        }
        actions={
          <IdeaActionsMenu
            idea={data}
            projectId={projectId}
            showOpen={false}
            onDeleted={() =>
              void navigate({ to: '/projects/$projectId/ideas', params: { projectId } })
            }
          />
        }
      />

      {data.lastError && (
        <Alert tone="danger" title={t('ideas.board.stuckReason')}>
          {data.lastError}
        </Alert>
      )}

      <IdeaSettingsForm idea={data} projectId={projectId} />
      <IdeaCanvas ideaId={ideaId} />
      <IdeaAssets ideaId={ideaId} />
      <IdeaComments ideaId={ideaId} />
      <IdeaPrompts idea={data} projectId={projectId} />
    </div>
  )
}
