import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { parseNumberInput } from '@/shared/lib/number-input'
import { timezoneOptions } from '@/shared/lib/timezones'
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
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'
import { type Automation, useCreateAutomation, useUpdateAutomation } from '../hooks/use-automations'
import {
  cronFromFields,
  type DayOfWeek,
  DEFAULT_SCHEDULE_FIELDS,
  fieldsFromCron,
  type ScheduleFieldsValue,
} from '../lib/schedule'
import { automationFormSchema } from '../model/automation-form.schema'
import { FormField } from './form-field'
import { ScheduleFields } from './schedule-fields'

const AUTOMATION_FORM_ID = 'automation-form'

interface SelectOption {
  value: string
  label: string
  description?: string
}

interface FormState {
  name: string
  prompt: string
  schedule: ScheduleFieldsValue
  timezone: string
  orchestrator: string
  baseBranch: string
  maxBudgetUsd: number | null
  /** Create only — editing paused state happens outside this dialog, via the
   *  list's own Switch or the detail page's Pause/Resume button. */
  startPaused: boolean
}

/** The browser's own zone if `timezoneOptions()` actually offers it, else
 *  `'UTC'` — a fresh automation's starting point, same fallback rule the
 *  brief asks for. */
function defaultTimezone(zones: { value: string }[]): string {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zones.some((zone) => zone.value === browserZone) ? browserZone : 'UTC'
}

function blankState(zones: { value: string }[]): FormState {
  return {
    name: '',
    prompt: '',
    schedule: DEFAULT_SCHEDULE_FIELDS,
    timezone: defaultTimezone(zones),
    orchestrator: '',
    baseBranch: '',
    maxBudgetUsd: null,
    startPaused: false,
  }
}

function stateFromAutomation(automation: Automation): FormState {
  return {
    name: automation.name,
    prompt: automation.prompt,
    schedule: fieldsFromCron(automation.cron),
    timezone: automation.timezone,
    orchestrator: automation.orchestrator,
    baseBranch: automation.baseBranch ?? '',
    maxBudgetUsd: automation.maxBudgetUsd,
    startPaused: automation.paused,
  }
}

/**
 * Create and edit share this one dialog — the same name/prompt/schedule/
 * orchestrator/base-branch/budget fields either way, the server telling the
 * two apart only by which endpoint this calls. Plain `useState` and a manual
 * `safeParse` on submit, not `react-hook-form`: the schedule's own kind
 * selector reshapes which of the rest of its fields apply, the same reason
 * `model/automation-form.schema.ts` and `idea-canvas.tsx`'s `BlockDialog`
 * give for the identical choice.
 *
 * Edit always sends the full editable set rather than a diff against the
 * loaded automation — the same choice `IdeaSettingsDialog` makes for the
 * identical shape of form.
 */
export function AutomationFormDialog({
  projectId,
  automation,
  open,
  onOpenChange,
}: {
  projectId: string
  /** Absent means "create"; present means "edit this one". */
  automation?: Automation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { data: agents } = useAgents()
  const zones = timezoneOptions()
  const isEdit = automation !== undefined
  const create = useCreateAutomation(projectId)
  const update = useUpdateAutomation(projectId)
  const busy = create.isPending || update.isPending

  const [state, setState] = useState<FormState>(() => blankState(zones))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [scheduleValid, setScheduleValid] = useState(true)

  // Re-seeds on every open, not just the first — same reasoning
  // `IdeaSettingsDialog`'s identical effect gives: a cancel-and-reopen must
  // show the automation's actual saved values, not whatever was abandoned.
  //
  // Keyed on the automation's *id*, not the automation object itself:
  // `AutomationDetailPage` polls its automation every 15s (use-automations.ts),
  // and runCount/lastRunAt/nextRunAt moving on a firing hands this a new
  // object with the same id every time — reseeding on that would wipe
  // whatever the reader is mid-typing here. `open` going false→true is what
  // actually means "the dialog just opened"; the id is what means "this is a
  // different automation", for the (currently unreachable through the UI,
  // since the dialog is modal) case of the same open dialog being handed a
  // different one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zones is a cached, effectively-static module singleton (shared/lib/timezones.ts); reading straight from `automation` below (not just its id) is intentional — see the comment above
  useEffect(() => {
    if (!open) return
    setState(automation ? stateFromAutomation(automation) : blankState(zones))
    setFieldErrors({})
    setServerError(null)
  }, [open, automation?.id])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((s) => ({ ...s, [key]: value }))

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  const orchestratorOptions: SelectOption[] = orchestrators.map((a) => ({
    value: a.name,
    label: a.name,
    description: a.description,
  }))

  const onSubmit = () => {
    const candidate = {
      name: state.name,
      prompt: state.prompt,
      scheduleKind: state.schedule.scheduleKind,
      time: state.schedule.time,
      days: state.schedule.days,
      everyHours: state.schedule.everyHours,
      minute: state.schedule.minute,
      customCron: state.schedule.customCron,
      timezone: state.timezone,
      orchestrator: state.orchestrator,
      baseBranch: state.baseBranch,
      maxBudgetUsd: state.maxBudgetUsd ?? undefined,
      startPaused: state.startPaused,
    }
    const result = automationFormSchema.safeParse(candidate)
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors as Record<string, string[] | undefined>
      const next: Record<string, string> = {}
      for (const [field, messages] of Object.entries(flat)) {
        if (messages?.[0]) next[field] = t(messages[0])
      }
      setFieldErrors(next)
      return
    }
    setFieldErrors({})
    setServerError(null)

    const cron = cronFromFields({
      scheduleKind: result.data.scheduleKind,
      time: result.data.time,
      days: result.data.days as DayOfWeek[],
      everyHours: result.data.everyHours,
      minute: result.data.minute,
      customCron: result.data.customCron,
    })

    const onError = (e: unknown) =>
      setServerError(
        apiErrorMessage(
          e,
          isEdit ? t('automations.form.updateFailed') : t('automations.form.createFailed'),
        ),
      )
    const onSuccess = () => onOpenChange(false)

    if (isEdit && automation) {
      update.mutate(
        {
          path: { id: automation.id },
          body: {
            name: result.data.name,
            prompt: result.data.prompt,
            cron,
            timezone: result.data.timezone,
            orchestrator: result.data.orchestrator,
            baseBranch: result.data.baseBranch ? result.data.baseBranch : null,
            maxBudgetUsd: result.data.maxBudgetUsd ?? null,
          },
        },
        { onSuccess, onError },
      )
    } else {
      create.mutate(
        {
          path: { id: projectId },
          body: {
            name: result.data.name,
            prompt: result.data.prompt,
            cron,
            timezone: result.data.timezone,
            orchestrator: result.data.orchestrator,
            ...(result.data.baseBranch ? { baseBranch: result.data.baseBranch } : {}),
            ...(result.data.maxBudgetUsd != null ? { maxBudgetUsd: result.data.maxBudgetUsd } : {}),
            ...(result.data.startPaused ? { paused: true } : {}),
          },
        },
        { onSuccess, onError },
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('automations.form.editHeading') : t('automations.form.createHeading')}
          </DialogTitle>
        </DialogHeader>

        <form
          id={AUTOMATION_FORM_ID}
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
          noValidate
          className="flex flex-col gap-3"
        >
          <FormField label={t('automations.form.name')} error={fieldErrors.name}>
            {(field) => (
              <Input
                value={state.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('automations.form.namePlaceholder')}
                {...field}
              />
            )}
          </FormField>

          <FormField label={t('automations.form.prompt')} error={fieldErrors.prompt}>
            {(field) => (
              <Textarea
                rows={6}
                value={state.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                placeholder={t('automations.form.promptPlaceholder')}
                {...field}
              />
            )}
          </FormField>

          <ScheduleFields
            value={state.schedule}
            onChange={(patch) => set('schedule', { ...state.schedule, ...patch })}
            timezone={state.timezone}
            onTimezoneChange={(timezone) => set('timezone', timezone)}
            daysError={fieldErrors.days}
            customCronError={fieldErrors.customCron}
            onValidityChange={setScheduleValid}
          />

          <FormField
            label={t('automations.form.orchestrator')}
            hint={
              orchestrators.length === 0
                ? t('automations.form.orchestratorEmpty')
                : t('automations.form.orchestratorHint')
            }
            error={fieldErrors.orchestrator}
          >
            {(field) => (
              <Select
                items={orchestratorOptions}
                value={state.orchestrator || null}
                onValueChange={(value) => set('orchestrator', value ?? '')}
              >
                <SelectTrigger className="w-full" {...field}>
                  <SelectValue placeholder={t('automations.form.orchestratorPlaceholder')} />
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
          </FormField>

          <FormField
            label={t('automations.form.baseBranch')}
            hint={t('automations.form.baseBranchHint')}
          >
            {(field) => (
              <Input
                className="font-mono"
                value={state.baseBranch}
                onChange={(e) => set('baseBranch', e.target.value)}
                {...field}
              />
            )}
          </FormField>

          <FormField
            label={t('automations.form.budget')}
            hint={t('automations.form.budgetHint')}
            error={fieldErrors.maxBudgetUsd}
          >
            {(field) => (
              <Input
                type="number"
                min={1}
                max={1000}
                value={state.maxBudgetUsd ?? ''}
                onChange={(e) => set('maxBudgetUsd', parseNumberInput(e))}
                {...field}
              />
            )}
          </FormField>

          {!isEdit && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="automation-start-paused">
                  {t('automations.form.startPaused')}
                </FieldLabel>
                <FieldDescription>{t('automations.form.startPausedHint')}</FieldDescription>
              </FieldContent>
              <Switch
                id="automation-start-paused"
                checked={state.startPaused}
                onCheckedChange={(checked) => set('startPaused', checked)}
              />
            </Field>
          )}

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
          <Button type="submit" form={AUTOMATION_FORM_ID} disabled={busy || !scheduleValid}>
            {busy && <Spinner data-icon="inline-start" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
