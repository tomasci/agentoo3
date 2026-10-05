import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { timezoneOptions } from '@/shared/lib/timezones'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Checkbox } from '@/shared/ui/checkbox'
import { FieldContent, FieldLabel, Field as FieldRoot } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { usePreviewSchedule } from '../hooks/use-automations'
import { formatInZone } from '../lib/format'
import {
  cronFromFields,
  type DayOfWeek,
  EVERY_N_HOURS_OPTIONS,
  type ScheduleFieldsValue,
  type ScheduleKind,
} from '../lib/schedule'
import { FormField } from './form-field'

const SCHEDULE_KINDS: ScheduleKind[] = ['daily', 'weekdays', 'weekends', 'days', 'hourly', 'custom']

const DAY_ORDER: DayOfWeek[] = [0, 1, 2, 3, 4, 5, 6]
const DAY_LABEL_KEY: Record<DayOfWeek, string> = {
  0: 'automations.schedule.day.sun',
  1: 'automations.schedule.day.mon',
  2: 'automations.schedule.day.tue',
  3: 'automations.schedule.day.wed',
  4: 'automations.schedule.day.thu',
  5: 'automations.schedule.day.fri',
  6: 'automations.schedule.day.sat',
}

/** How long to let the reader keep typing/picking before asking the server
 *  to preview the result — short enough that the preview still feels live,
 *  long enough that every keystroke of a custom cron doesn't fire its own
 *  request. */
const PREVIEW_DEBOUNCE_MS = 400

interface ScheduleFieldsProps {
  value: ScheduleFieldsValue
  onChange: (patch: Partial<ScheduleFieldsValue>) => void
  timezone: string
  onTimezoneChange: (timezone: string) => void
  daysError?: string
  customCronError?: string
  /** Lifted so the dialog's Save button can disable itself while the
   *  server-side preview says the current cron is invalid. */
  onValidityChange: (valid: boolean) => void
}

/**
 * The schedule builder: a preset-kind selector, the fields that preset
 * needs, a timezone picker, and a live preview of the next few times it
 * would actually fire — debounced against `POST /automations/schedule-
 * preview` (`usePreviewSchedule`), which answers `200 { valid, error,
 * nextRuns }` even for a nonsense cron (never a 400 — see that endpoint's
 * own doc comment), so the "is this valid" question always has somewhere to
 * land other than a thrown error.
 */
export function ScheduleFields({
  value,
  onChange,
  timezone,
  onTimezoneChange,
  daysError,
  customCronError,
  onValidityChange,
}: ScheduleFieldsProps) {
  const { t } = useTranslation()
  const zones = timezoneOptions()
  const preview = usePreviewSchedule()
  const cron = cronFromFields(value)

  // Debounced rather than fired on every keystroke/click — see the module
  // comment. Keyed on the two things that change what gets previewed; `t`
  // only matters for *rendering* the result, not for what to ask the server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview.mutate is a stable react-query function, not a reactive input
  useEffect(() => {
    const id = setTimeout(() => {
      preview.mutate({ body: { cron, timezone, count: 5 } })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [cron, timezone])

  const result = preview.data
  // A preview answers the exact cron+timezone it was asked about, not
  // necessarily the ones showing right now — the reader can keep typing
  // while a request is in flight, and a brand-new `mutate()` call clears
  // `preview.data` back to `undefined` the moment it starts (react-query's
  // own behaviour for a mutation's `data`, unlike a query's, which would
  // otherwise read a *pending* re-check as "nothing known, so fine").
  // `preview.variables` is what the *current* (in-flight or just-settled)
  // call was actually asked, so comparing it against this render's own
  // `cron`/`timezone` is what tells a stale or in-flight answer apart from a
  // fresh, trustworthy one — `status` alone cannot: it stays `'success'`
  // from the previous call for the entire time the next one is in flight.
  //
  // `'idle'` — no preview has ever been sent for this dialog at all — is the
  // one case read as valid rather than "not yet known": every dialog opens
  // already holding a cron (a fresh create's default preset, or an edit's
  // saved one), and a reader who saves before the first debounce even fires
  // is saving exactly what was already there, not something unchecked.
  const matchesCurrentInput =
    preview.variables?.body?.cron === cron && preview.variables?.body?.timezone === timezone
  const valid =
    preview.status === 'idle' ||
    (preview.status === 'success' && matchesCurrentInput && result?.valid === true)
  const onValidityChangeRef = useRef(onValidityChange)
  onValidityChangeRef.current = onValidityChange
  useEffect(() => {
    onValidityChangeRef.current(valid)
  }, [valid])

  const toggleDay = (day: DayOfWeek) => {
    const next = value.days.includes(day)
      ? value.days.filter((d) => d !== day)
      : [...value.days, day].sort((a, b) => a - b)
    onChange({ days: next })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <FormField label={t('automations.form.scheduleKind')}>
        {(field) => (
          <Select
            items={SCHEDULE_KINDS.map((kind) => ({
              value: kind,
              label: t(`automations.schedule.kind.${kind}`),
            }))}
            value={value.scheduleKind}
            onValueChange={(kind) => kind && onChange({ scheduleKind: kind as ScheduleKind })}
          >
            <SelectTrigger className="w-full" {...field}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`automations.schedule.kind.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      {(value.scheduleKind === 'daily' ||
        value.scheduleKind === 'weekdays' ||
        value.scheduleKind === 'weekends' ||
        value.scheduleKind === 'days') && (
        <FormField label={t('automations.form.time')}>
          {(field) => (
            <Input
              type="time"
              className="w-32"
              value={value.time}
              onChange={(e) => onChange({ time: e.target.value })}
              {...field}
            />
          )}
        </FormField>
      )}

      {value.scheduleKind === 'days' && (
        <FormField label={t('automations.form.days')} error={daysError}>
          {() => (
            <div className="flex flex-wrap gap-3">
              {DAY_ORDER.map((day) => (
                <FieldRoot key={day} orientation="horizontal" className="w-fit gap-1.5">
                  <Checkbox
                    id={`automation-day-${day}`}
                    checked={value.days.includes(day)}
                    onCheckedChange={() => toggleDay(day)}
                  />
                  <FieldLabel htmlFor={`automation-day-${day}`}>{t(DAY_LABEL_KEY[day])}</FieldLabel>
                </FieldRoot>
              ))}
            </div>
          )}
        </FormField>
      )}

      {value.scheduleKind === 'hourly' && (
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t('automations.form.everyHours')}>
            {(field) => (
              <Select
                items={EVERY_N_HOURS_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
                value={String(value.everyHours)}
                onValueChange={(n) => n && onChange({ everyHours: Number(n) })}
              >
                <SelectTrigger className="w-24" {...field}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVERY_N_HOURS_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField
            label={t('automations.form.minute')}
            hint={t('automations.form.everyHoursHint')}
          >
            {(field) => (
              <Input
                type="number"
                min={0}
                max={59}
                className="w-24"
                value={value.minute}
                onChange={(e) => {
                  const n = e.target.valueAsNumber
                  if (!Number.isNaN(n)) onChange({ minute: Math.min(59, Math.max(0, n)) })
                }}
                {...field}
              />
            )}
          </FormField>
        </div>
      )}

      {value.scheduleKind === 'custom' && (
        <FormField
          label={t('automations.form.customCron')}
          hint={t('automations.form.customCronHint')}
          error={customCronError}
        >
          {(field) => (
            <Input
              className="font-mono"
              value={value.customCron}
              onChange={(e) => onChange({ customCron: e.target.value })}
              {...field}
            />
          )}
        </FormField>
      )}

      <FormField label={t('automations.form.timezone')}>
        {(field) => (
          <Select items={zones} value={timezone} onValueChange={(z) => z && onTimezoneChange(z)}>
            <SelectTrigger className="w-full" {...field}>
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
      </FormField>

      <FieldContent>
        <FieldLabel>{t('automations.form.preview')}</FieldLabel>
        {preview.isPending ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t('automations.form.previewLoading')}
          </span>
        ) : preview.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {apiErrorMessage(preview.error, t('automations.form.previewFailed'))}
            </AlertDescription>
          </Alert>
        ) : result && !result.valid ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {result.error ?? t('automations.form.previewInvalid')}
            </AlertDescription>
          </Alert>
        ) : result && result.nextRuns.length > 0 ? (
          <ul className="m-0 list-none p-0 text-sm text-muted-foreground">
            {result.nextRuns.map((run) => (
              <li key={run}>{formatInZone(run, timezone)}</li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t('automations.form.previewEmpty')}
          </span>
        )}
      </FieldContent>
    </div>
  )
}
