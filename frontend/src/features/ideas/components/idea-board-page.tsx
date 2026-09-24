import { zodResolver } from '@hookform/resolvers/zod'
import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader } from '@/shared/components'
import { parseNumberInput } from '@/shared/lib/number-input'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { useCreateIdea, useIdeas } from '../hooks/use-ideas'
import { IDEA_STATUS_I18N_KEY, IDEA_STATUSES } from '../lib/status'
import { type CreateIdeaFormValues, createIdeaFormSchema } from '../model/idea-form.schema'
import { FormField } from './form-field'
import { IdeaCard } from './idea-card'

interface SelectOption {
  value: string
  label: string
  description?: string
}

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ideas.form.createHeading')}</DialogTitle>
        </DialogHeader>

        <form
          id={CREATE_IDEA_FORM_ID}
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="flex flex-col gap-3"
        >
          <FormField label={t('ideas.form.title')} error={fieldError(errors.title?.message)}>
            {(field) => (
              <Input
                placeholder={t('ideas.form.titlePlaceholder')}
                {...register('title')}
                {...field}
              />
            )}
          </FormField>

          <FormField label={t('ideas.form.startColumn')}>
            {(field) => (
              <Controller
                control={control}
                name="status"
                render={({ field: rhf }) => (
                  <Select
                    items={statusOptions}
                    value={rhf.value}
                    onValueChange={(value) => rhf.onChange(value ?? 'backlog')}
                    inputRef={rhf.ref}
                    name={rhf.name}
                  >
                    <SelectTrigger className="w-full" {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </FormField>

          <FormField
            label={t('ideas.form.orchestrator')}
            hint={
              orchestrators.length === 0
                ? t('ideas.form.orchestratorEmpty')
                : t('ideas.form.orchestratorHint')
            }
            error={fieldError(errors.orchestrator?.message)}
          >
            {(field) => (
              <Controller
                control={control}
                name="orchestrator"
                render={({ field: rhf }) => (
                  <Select
                    items={orchestratorOptions}
                    value={rhf.value || ''}
                    onValueChange={(value) => rhf.onChange(value ?? '')}
                    inputRef={rhf.ref}
                    name={rhf.name}
                  >
                    <SelectTrigger className="w-full" {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {orchestratorOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className="flex min-w-0 flex-col">
                            <span>{option.label}</span>
                            {option.description && (
                              <span className="text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </FormField>

          <FormField
            label={t('ideas.form.baseBranch')}
            hint={t('ideas.form.baseBranchHint')}
            error={fieldError(errors.baseBranch?.message)}
          >
            {(field) => <Input className="font-mono" {...register('baseBranch')} {...field} />}
          </FormField>

          <FormField
            label={t('ideas.form.budget')}
            hint={t('ideas.form.budgetHint')}
            error={fieldError(errors.maxBudgetUsd?.message)}
          >
            {(field) => (
              <Controller
                control={control}
                name="maxBudgetUsd"
                render={({ field: rhf }) => (
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={rhf.value ?? ''}
                    onChange={(e) => rhf.onChange(parseNumberInput(e) ?? undefined)}
                    name={rhf.name}
                    ref={rhf.ref}
                    {...field}
                  />
                )}
              />
            )}
          </FormField>

          {serverError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('common.cancel')}
          </DialogClose>
          <Button type="submit" form={CREATE_IDEA_FORM_ID} disabled={create.isPending}>
            {create.isPending && <Spinner data-icon="inline-start" />}
            {t('ideas.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
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
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('ideas.heading')}
        actions={
          <Button type="button" onClick={() => setShowCreate(true)}>
            {t('ideas.board.addIdea')}
          </Button>
        }
      />

      {ideas.isError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{apiErrorMessage(ideas.error, t('ideas.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {ideas.isPending && <Loading label={t('common.loading')} block />}

      {!ideas.isPending && !ideas.isError && (
        // Six columns side by side on anything wide enough, each shrinking to
        // a minimum before the strip itself scrolls — a real kanban board
        // rather than six squeezed slivers. Below `md` this snaps one column
        // at a time: the phone shape this page deliberately chose over
        // trying to cram six columns into 360px.
        //
        // `p-1 -m-1`: `Card`'s edge (shared/ui/card.tsx) is a `ring-1`, a
        // box-shadow painted outside the element, and `overflow-x-auto` clips
        // at the padding edge — without this, the first column's cards lose
        // their left ring, the last column's lose their right one, and any
        // card touching the strip's own top loses that edge too. The
        // negative margin cancels the padding's own footprint so the columns
        // still line up with the page header above. `scroll-px-1` matches
        // that padding as scroll-padding: without it `snap-start` snaps the
        // first/last column flush to the scrollport edge, scrolling the
        // padding (and the ring it protects) out of view on load.
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-1 p-1 -m-1 pb-2 md:snap-proximity">
          {columns.map(({ status, items }) => (
            <section
              key={status}
              className="flex min-w-0 shrink-0 grow-0 basis-full snap-start flex-col gap-3 md:min-w-64 md:shrink md:grow md:basis-64"
              aria-label={t(IDEA_STATUS_I18N_KEY[status])}
            >
              <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                {t(IDEA_STATUS_I18N_KEY[status])}
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </h3>
              <div className="flex min-h-16 flex-col gap-3">
                {items.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>{t('ideas.board.empty')}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  items.map((idea) => <IdeaCard key={idea.id} idea={idea} projectId={projectId} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <CreateIdeaDialog projectId={projectId} open={showCreate} onOpenChange={setShowCreate} />
    </div>
  )
}
