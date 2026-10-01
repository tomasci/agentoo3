import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, toast } from '@/shared/components'
import { parseNumberInput } from '@/shared/lib/number-input'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { useSystemSettings, useUpdateSystemSettings } from '../hooks/use-system-settings'
import {
  type SystemSettingsFormValues,
  systemSettingsFormSchema,
} from '../model/system-settings-form.schema'

const FIELD_ID = 'settings-max-concurrent-sessions'
const MESSAGE_ID = `${FIELD_ID}-message`

/**
 * The server-held counterpart to the language/theme card above it on
 * SettingsPage: how many session turns the whole installation's worker may
 * run at once. Unlike that card, there is no client-side default to show
 * before the server answers, so this one owns its own query/loading/error
 * states rather than assuming the page around it already handled that —
 * which is also why SettingsPage renders this unconditionally rather than
 * gating the whole page behind this one card's data (see that file's own
 * doc comment).
 */
export function SessionLimitCard() {
  const { t } = useTranslation()
  const { data: settings, isPending, isError, error: loadError } = useSystemSettings()
  const update = useUpdateSystemSettings()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SystemSettingsFormValues>({
    resolver: zodResolver(systemSettingsFormSchema),
    // The form itself only ever renders once `settings` has loaded (below),
    // so this fallback is never actually shown — it only keeps useForm
    // type-happy for the render(s) before that.
    defaultValues: { maxConcurrentSessions: settings?.maxConcurrentSessions.value ?? 1 },
  })

  // Re-seeds on first load and on changes arriving from elsewhere — the
  // polling worker aside, a change saved from a second tab. It is not enough
  // on its own for this card's own save/reset: a saved value can equal the
  // server value already in cache (an override saved at the default, or a
  // reset from an override that already equalled the default), in which case
  // `serverValue` never changes and this effect never re-runs. save() and
  // resetToDefault() below cover that by re-seeding straight from the
  // mutation's own response instead of waiting on this effect.
  const serverValue = settings?.maxConcurrentSessions.value
  useEffect(() => {
    if (serverValue === undefined) return
    reset({ maxConcurrentSessions: serverValue })
  }, [serverValue, reset])

  const save = (values: SystemSettingsFormValues) => {
    setServerError(null)
    update.mutate(
      { body: { maxConcurrentSessions: values.maxConcurrentSessions } },
      {
        onSuccess: (data) => {
          reset({ maxConcurrentSessions: data.maxConcurrentSessions.value })
          toast.add({ title: t('settings.saved'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('settings.saveFailed'))),
      },
    )
  }

  const resetToDefault = () => {
    setServerError(null)
    update.mutate(
      { body: { maxConcurrentSessions: null } },
      {
        onSuccess: (data) => {
          reset({ maxConcurrentSessions: data.maxConcurrentSessions.value })
          toast.add({ title: t('settings.reset'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('settings.resetFailed'))),
      },
    )
  }

  const fieldError = errors.maxConcurrentSessions?.message

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sessionsHeading')}</CardTitle>
        <CardDescription>{t('settings.sessionsLead')}</CardDescription>
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
        {!isPending && !isError && settings && (
          <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-4">
            <FieldGroup>
              <Field data-invalid={fieldError ? true : undefined}>
                <FieldLabel htmlFor={FIELD_ID}>{t('settings.maxConcurrentSessions')}</FieldLabel>
                <Controller
                  control={control}
                  name="maxConcurrentSessions"
                  render={({ field }) => (
                    <Input
                      id={FIELD_ID}
                      type="number"
                      min={1}
                      max={64}
                      step={1}
                      inputMode="numeric"
                      aria-invalid={Boolean(fieldError)}
                      aria-describedby={MESSAGE_ID}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(parseNumberInput(e))}
                      name={field.name}
                      ref={field.ref}
                    />
                  )}
                />
                {fieldError ? (
                  <FieldError id={MESSAGE_ID}>{t(fieldError)}</FieldError>
                ) : (
                  <FieldDescription id={MESSAGE_ID}>
                    {t('settings.maxConcurrentSessionsHint')}
                    <br />
                    {settings.maxConcurrentSessions.source === 'default'
                      ? t('settings.maxConcurrentSessionsUsingDefault', {
                          value: settings.maxConcurrentSessions.defaultValue,
                        })
                      : t('settings.maxConcurrentSessionsOverridden', {
                          value: settings.maxConcurrentSessions.defaultValue,
                        })}
                  </FieldDescription>
                )}
              </Field>
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
                disabled={update.isPending || settings.maxConcurrentSessions.source === 'default'}
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
