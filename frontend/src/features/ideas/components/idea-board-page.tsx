import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  NumberInput,
  PageHeader,
  Select,
  type SelectOption,
  Spinner,
  Stack,
} from '@/shared/ui'
import { useCreateIdea, useIdeas } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUSES } from '../lib/status'
import { type CreateIdeaFormValues, createIdeaFormSchema } from '../model/idea-form.schema'
import styles from './idea-board.module.scss'
import { IdeaCard } from './idea-card'

const CREATE_IDEA_FORM_ID = 'create-idea-form'

function CreateIdeaDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { data: agents } = useAgents()
  const create = useCreateIdea(projectId)
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateIdeaFormValues>({
    resolver: zodResolver(createIdeaFormSchema),
    defaultValues: {
      title: '',
      status: 'backlog',
      orchestrator: '',
      baseBranch: '',
      maxBudgetUsd: undefined,
    },
  })

  // Zod's messages are translation keys, not display text — same idiom
  // `create-project-form.tsx` uses for the identical problem.
  const fieldError = (message?: string) => (message ? t(message) : undefined)

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  const orchestratorOptions: SelectOption[] = [
    { value: '', label: t('ideas.form.orchestratorNone') },
    ...orchestrators.map((a) => ({ value: a.name, label: a.name, description: a.description })),
  ]
  const statusOptions: SelectOption[] = IDEA_STATUSES.map((status) => ({
    value: status,
    label: t(IDEA_STATUS_I18N_KEY[status]),
  }))

  const onSubmit = (values: CreateIdeaFormValues) => {
    setServerError(null)
    create.mutate(
      {
        path: { id: projectId },
        body: {
          title: values.title,
          status: values.status,
          ...(values.orchestrator ? { orchestrator: values.orchestrator } : {}),
          ...(values.baseBranch ? { baseBranch: values.baseBranch } : {}),
          ...(values.maxBudgetUsd != null ? { maxBudgetUsd: values.maxBudgetUsd } : {}),
        },
      },
      {
        onSuccess: () => {
          reset()
          onOpenChange(false)
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('ideas.form.createFailed'))),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('ideas.form.createHeading')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={CREATE_IDEA_FORM_ID} loading={create.isPending}>
            {t('ideas.form.submit')}
          </Button>
        </>
      }
    >
      <form id={CREATE_IDEA_FORM_ID} onSubmit={handleSubmit(onSubmit)} noValidate>
        <Stack gap={3}>
          <Field label={t('ideas.form.title')} error={fieldError(errors.title?.message)}>
            <Input placeholder={t('ideas.form.titlePlaceholder')} {...register('title')} />
          </Field>

          <Field label={t('ideas.form.startColumn')}>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select
                  options={statusOptions}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value ?? 'backlog')}
                  name={field.name}
                  ref={field.ref}
                />
              )}
            />
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
                  value={field.value || ''}
                  onValueChange={(value) => field.onChange(value ?? '')}
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
                  value={field.value ?? null}
                  onValueChange={(value) => field.onChange(value ?? undefined)}
                  min={1}
                  max={1000}
                  name={field.name}
                />
              )}
            />
          </Field>

          {serverError && <Alert tone="danger">{serverError}</Alert>}
        </Stack>
      </form>
    </Dialog>
  )
}

/**
 * The board: six columns, in `IDEA_STATUSES` order, every one of them
 * rendered even with nothing in it — an empty column is information (a
 * `verification` column with nothing in it says the team is caught up).
 *
 * No drag-and-drop: a card moves through `IdeaActionsMenu` (used by
 * `IdeaCard`), which every idea on this board shares with the detail page.
 */
export function IdeaBoardPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const ideas = useIdeas(projectId)
  const [showCreate, setShowCreate] = useState(false)

  const columns = IDEA_STATUSES.map((status) => ({
    status,
    items: (ideas.data ?? []).filter((idea) => idea.status === status),
  }))

  return (
    <Stack gap={5}>
      <PageHeader
        title={t('ideas.heading')}
        actions={
          <Button type="button" onClick={() => setShowCreate(true)}>
            {t('ideas.board.addIdea')}
          </Button>
        }
      />

      {ideas.isError && (
        <Alert tone="danger">{apiErrorMessage(ideas.error, t('ideas.loadFailed'))}</Alert>
      )}
      {ideas.isPending && <Spinner label={t('common.loading')} block />}

      {!ideas.isPending && !ideas.isError && (
        <div className={styles.board}>
          {columns.map(({ status, items }) => (
            <section
              key={status}
              className={styles.column}
              aria-label={t(IDEA_STATUS_I18N_KEY[status])}
            >
              <h3 className={styles.columnHeading}>
                {t(IDEA_STATUS_I18N_KEY[status])}
                <span className={styles.columnCount}>{items.length}</span>
              </h3>
              <div className={styles.columnBody}>
                {items.length === 0 ? (
                  <EmptyState size="sm" title={t('ideas.board.empty')} />
                ) : (
                  items.map((idea) => <IdeaCard key={idea.id} idea={idea} projectId={projectId} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <CreateIdeaDialog projectId={projectId} open={showCreate} onOpenChange={setShowCreate} />
    </Stack>
  )
}
