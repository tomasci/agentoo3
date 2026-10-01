import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import type { LearningSchedule } from '@/shared/api/generated/types/LearningSchedule'
import { Loading, toast } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { Switch } from '@/shared/ui/switch'
import { useSystemSettings, useUpdateSystemSettings } from '../hooks/use-system-settings'
import { timezoneOptions, zoneWithOffset } from '../lib/timezones'
import {
  type LearningScheduleFormValues,
  learningScheduleFormSchema,
} from '../model/learning-schedule-form.schema'

const FIELD_ID = 'settings-learning'
const DEFAULT_VALUES: LearningScheduleFormValues = {
  enabled: false,
  time: '04:00',
  timezone: 'UTC',
}

/**
 * The schedule the background learning job reviews sessions on — the server-
 * held sibling of `SessionLimitCard` right above it on the page, following the
 * same query/loading/error-owning, save/reset-to-default pattern. "Run
 * learning now" (the Suggested view's own button) is unaffected by `enabled`
 * here: this only controls the daily automatic run.
 */
export function LearningScheduleCard() {
  const { t } = useTranslation()
  const { data: settings, isPending, isError, error: loadError } = useSystemSettings()
  const update = useUpdateSystemSettings()
  const [serverError, setServerError] = useState<string | null>(null)
  const zones = timezoneOptions()

  const {
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<LearningScheduleFormValues>({
    resolver: zodResolver(learningScheduleFormSchema),
    // Never actually shown — see SessionLimitCard's identical comment on its
    // own `defaultValues` — the form only renders once `settings` has loaded.
    defaultValues: settings?.learningSchedule?.value ?? DEFAULT_VALUES,
  })

  const serverValue = settings?.learningSchedule?.value
  useEffect(() => {
    if (!serverValue) return
    reset(serverValue)
  }, [serverValue, reset])

  const save = (values: LearningScheduleFormValues) => {
    setServerError(null)
    update.mutate(
      { body: { learningSchedule: values } },
      {
        onSuccess: (data) => {
          reset(data.learningSchedule.value)
          toast.add({ title: t('settings.saved'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('settings.saveFailed'))),
      },
    )
  }

  const resetToDefault = () => {
    setServerError(null)
    update.mutate(
      {
        // The generated `PatchApiSystemSettingsBody` types this field as
        // `LearningSchedule`, not `LearningSchedule | null`, unlike its
        // `maxConcurrentSessions` sibling right above it in the same type —
        // a gap in the OpenAPI spec this client was generated from, since the
        // API itself documents `null` as "reset to default" (see
        // ApplyLibrarySuggestion's sibling doc comments in the same schema
        // for the same contract elsewhere). Not a backend fix this agent
        // owns — cast through `unknown` here rather than hand-editing the
        // generated type, and send the real runtime value the API expects.
        body: { learningSchedule: null as unknown as LearningSchedule },
      },
      {
        onSuccess: (data) => {
          reset(data.learningSchedule.value)
          toast.add({ title: t('settings.reset'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('settings.resetFailed'))),
      },
    )
  }

  const enabled = watch('enabled')
  const timeError = errors.time?.message
  const timezoneError = errors.timezone?.message

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.learningHeading')}</CardTitle>
        <CardDescription>{t('settings.learningLead')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(loadError, t('settings.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {isPending && <Loading label={t('common.loading')} />}
        {!isPending && !isError && settings?.learningSchedule && (
          <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-4">
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`${FIELD_ID}-enabled`}>
                    {t('settings.learningEnabled')}
                  </FieldLabel>
                  <FieldDescription>{t('settings.learningEnabledHint')}</FieldDescription>
                </FieldContent>
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <Switch
                      id={`${FIELD_ID}-enabled`}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </Field>

              <Field data-invalid={timeError ? true : undefined}>
                <FieldLabel htmlFor={`${FIELD_ID}-time`}>{t('settings.learningTime')}</FieldLabel>
                <Controller
                  control={control}
                  name="time"
                  render={({ field }) => (
                    <Input
                      id={`${FIELD_ID}-time`}
                      type="time"
                      disabled={!enabled}
                      aria-invalid={Boolean(timeError)}
                      value={field.value}
                      onChange={field.onChange}
                      name={field.name}
                      ref={field.ref}
                      className="w-32"
                    />
                  )}
                />
                {timeError ? (
                  <FieldError>{t(timeError)}</FieldError>
                ) : (
                  <FieldDescription>{t('settings.learningTimeHint')}</FieldDescription>
                )}
              </Field>

              <Field data-invalid={timezoneError ? true : undefined}>
                <FieldLabel htmlFor={`${FIELD_ID}-timezone`}>
                  {t('settings.learningTimezone')}
                </FieldLabel>
                <Controller
                  control={control}
                  name="timezone"
                  render={({ field }) => (
                    <Select
                      items={zones}
                      value={field.value}
                      onValueChange={(value) => value && field.onChange(value)}
                    >
                      <SelectTrigger
                        id={`${FIELD_ID}-timezone`}
                        className="w-full sm:w-96"
                        disabled={!enabled}
                        aria-invalid={Boolean(timezoneError)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {zones.map((zone) => (
                          <SelectItem key={zone.value} value={zone.value}>
                            {zone.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {timezoneError && <FieldError>{t(timezoneError)}</FieldError>}
              </Field>

              <FieldDescription>
                {settings.learningSchedule.value.enabled
                  ? t('settings.learningScheduleOn', {
                      time: settings.learningSchedule.value.time,
                      timezone: zoneWithOffset(settings.learningSchedule.value.timezone),
                    })
                  : t('settings.learningScheduleOff')}
                <br />
                {settings.learningSchedule.nextRunAt
                  ? t('settings.learningNextRun', {
                      when: new Date(settings.learningSchedule.nextRunAt).toLocaleString(),
                    })
                  : t('settings.learningNextRunNone')}
                <br />
                {settings.learningSchedule.source === 'default'
                  ? t('settings.learningUsingDefault')
                  : t('settings.learningOverridden')}
              </FieldDescription>
            </FieldGroup>

            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={update.isPending}>
                {update.isPending && <Spinner data-icon="inline-start" />}
                {t('common.save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={update.isPending || settings.learningSchedule.source === 'default'}
                onClick={resetToDefault}
              >
                {t('settings.resetToDefault')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
