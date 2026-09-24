import { zodResolver } from '@hookform/resolvers/zod'
import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { toast } from '@/shared/components'
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
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { type Idea, useUpdateIdea } from '../hooks/use-ideas'
import { type UpdateIdeaFormValues, updateIdeaFormSchema } from '../model/idea-form.schema'
import { FormField } from './form-field'

interface SelectOption {
  value: string
  label: string
  description?: string
}

const IDEA_SETTINGS_FORM_ID = 'idea-settings-form'

/**
 * Orchestrator, base branch and budget: chosen up front, in this dialog,
 * since the session those fields describe is not created until handoff —
 * this is the one place to change them before that happens. `title` rides
 * along in the same save rather than getting an inline-edit of its own,
 * matching `AgentEditorPage`'s one-form-one-save shape for the identical
 * kind of page, even though the page itself renders `title` read-only in its
 * header now.
 *
 * Owns its own trigger and its own `open` state — same shape as
 * `IdeaActionsMenu` — so `IdeaDetailPage` stays a layout function with no
 * state of its own.
 */
export function IdeaSettingsDialog({ idea, projectId }: { idea: Idea; projectId: string }) {
  const { t } = useTranslation()
  const { data: agents } = useAgents()
  const update = useUpdateIdea(projectId)
  const [open, setOpen] = useState(false)
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

  // Keyed on `open` and the id, not the whole (polling) `idea` row: `useIdea`
  // (hooks/use-ideas.ts) refetches every 1.5s while the idea is busy, and
  // resetting on every one of those would overwrite whatever the reader is
  // mid-typing here. `open` in the deps is what re-seeds from the current row
  // on every open rather than only the first — without it, a cancel-and-
  // reopen would still show whatever the reader abandoned last time instead
  // of the idea's actual saved values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return
    reset({
      title: idea.title,
      orchestrator: idea.orchestrator,
      baseBranch: idea.baseBranch,
      maxBudgetUsd: idea.maxBudgetUsd,
    })
    setServerError(null)
  }, [open, idea.id])

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
        onSuccess: () => {
          toast.add({ title: t('ideas.detail.settingsSaved'), type: 'success' })
          setOpen(false)
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('ideas.form.updateFailed'))),
      },
    )
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('ideas.detail.settingsHeading')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ideas.detail.settingsHeading')}</DialogTitle>
          </DialogHeader>

          <form
            id={IDEA_SETTINGS_FORM_ID}
            onSubmit={handleSubmit(onSubmit)}
            noValidate
            className="flex flex-col gap-3"
          >
            <FormField label={t('ideas.form.title')} error={fieldError(errors.title?.message)}>
              {(field) => <Input {...register('title')} {...field} />}
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
                      value={rhf.value ?? ''}
                      onValueChange={(value) => rhf.onChange(value || null)}
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
                      onChange={(e) => rhf.onChange(parseNumberInput(e))}
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
            <Button type="submit" form={IDEA_SETTINGS_FORM_ID} disabled={update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              {t('ideas.form.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
