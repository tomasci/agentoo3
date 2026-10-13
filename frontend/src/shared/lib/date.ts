import { format, isValid, type Locale } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { ru } from 'date-fns/locale/ru'

/**
 * The date-fns locale for an i18next language — `ru*` is Russian, everything
 * else (including `undefined`, which is what `i18n.resolvedLanguage` is before
 * init finishes) is English. Callers pass `useTranslation()`'s
 * `i18n.resolvedLanguage` rather than reading the i18n singleton here, so a
 * language switch re-renders them.
 */
export function dateLocale(language: string | undefined): Locale {
  return language?.startsWith('ru') ? ru : enUS
}

type DateInput = Date | string

/** A real instant, or `null` — `format` throws a RangeError on an invalid
 *  date, and a throw during render blanks the whole page over one bad cell. */
function parse(date: DateInput): Date | null {
  const parsed = typeof date === 'string' ? new Date(date) : date
  return isValid(parsed) ? parsed : null
}

/** `14:32` — 24-hour in both languages, matching the transcript's own
 *  `formatTime` (features/sessions/lib/format.ts). `''` for an invalid date. */
export function formatTimeOfDay(date: DateInput, language: string | undefined): string {
  const parsed = parse(date)
  return parsed ? format(parsed, 'HH:mm', { locale: dateLocale(language) }) : ''
}

/** `Sep 28, 2026, 14:32` / `28 сент. 2026 г., 14:32` — the locale's medium
 *  date, then the 24-hour time. `''` for an invalid date. */
export function formatDateTime(date: DateInput, language: string | undefined): string {
  const parsed = parse(date)
  return parsed ? format(parsed, 'PP, HH:mm', { locale: dateLocale(language) }) : ''
}

/** `Oct 7` / `7 окт.` — short month and day of month, no year, in the
 *  locale's own order. `''` for an invalid date. */
export function formatDayLabel(date: DateInput, language: string | undefined): string {
  const parsed = parse(date)
  if (!parsed) return ''
  const locale = dateLocale(language)
  return format(parsed, locale === ru ? 'd MMM' : 'MMM d', { locale })
}
