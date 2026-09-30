import type { UsageOverageStatusEnumKey } from '@/shared/api/generated/types/UsageOverage'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** `t`, threaded into the handful of plain (non-component) helpers below that
 * need translated text but cannot call the `useTranslation` hook themselves
 * — shared with `usage-page.tsx`, which threads its own `t` into
 * `authText` the same way. */
export type Translate = (key: string, options?: Record<string, unknown>) => string

export type MeterLevel = 'normal' | 'warning' | 'critical'

/** Below 75% reads as normal, 75–<90 as approaching the limit, ≥90 as
 * critical — the three-level emphasis the Plan limits card's own brief asks
 * for (two levels, `status-bar.tsx`'s own `HostMetric`, wasn't enough here:
 * a weekly window sitting at 80% deserves a different look than one at 8%,
 * well before it actually runs out). */
export function meterLevel(pct: number): MeterLevel {
  if (pct >= 90) return 'critical'
  if (pct >= 75) return 'warning'
  return 'normal'
}

/** Integer percent for display — the API's own `utilization` can carry
 * decimals (`8`, `23.4`, …), and a meter's label reads worse with any. */
export function roundPercent(value: number): number {
  return Math.round(value)
}

/** `roundPercent`, clamped to never read as negative — a source reporting an
 * out-of-contract negative `utilization` (which does happen) must not show
 * as "-5%"; 0% is the honest floor. The other end is left alone: a value
 * over 100 is shown as-is (the meter's own bar is already capped at 100%
 * width, so only the label would otherwise disagree with it). */
export function displayPercent(value: number): number {
  return Math.max(0, roundPercent(value))
}

/** True once a window's own `resetsAt` has already passed — only possible
 * for `source: 'observed'` data, where the rate-limit report can be older
 * than the window it describes: the window rolled over since the report was
 * recorded, so the percent it carries is no longer the current one and must
 * not be shown as if it still were. */
export function hasWindowReset(resetsAt: string | null, now: number): boolean {
  if (!resetsAt) return false
  const reset = new Date(resetsAt).getTime()
  return !Number.isNaN(reset) && reset <= now
}

/** A short countdown like "3h 16m" or "5d 17h" — the two largest non-zero
 * units, days down through minutes, with the unit words themselves coming
 * from i18n (`usage.window.duration.*`) rather than hardcoded English
 * letters, so a Russian reader sees "2 ч 40 мин", not "2h 40m". Callers only
 * ever ask this of a reset still ahead of `now` (see `hasWindowReset`, which
 * is what gates that), so a negative or sub-minute gap reads as "<1m" rather
 * than "0m" — which would read as already due when it is really just
 * close. */
export function formatDurationShort(ms: number, t: Translate): string {
  const clamped = Math.max(ms, 0)
  const days = Math.floor(clamped / DAY_MS)
  const hours = Math.floor((clamped % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((clamped % HOUR_MS) / MINUTE_MS)

  if (days > 0) return t('usage.window.duration.daysHours', { days, hours })
  if (hours > 0) return t('usage.window.duration.hoursMinutes', { hours, minutes })
  if (minutes > 0) return t('usage.window.duration.minutesOnly', { minutes })
  return t('usage.window.duration.lessThanMinute')
}

/** "4 minutes ago" (or, in principle, "in 4 minutes") in the given locale —
 * coarsest unit that still reads naturally. The unit is chosen *after*
 * rounding to that unit's own count, not before: rounding first and then
 * checking against the boundary is what makes 59m40s read as "1 hour ago"
 * rather than "60 minutes ago" — picking the unit from the un-rounded gap
 * and only then rounding into it lets the rounded figure spill past the
 * boundary the unit choice already assumed. Not
 * `features/editor/components/format-last-active.ts`'s helper reused: that
 * one is deliberately component-local because nothing there re-renders on a
 * timer (see its own comment) — this page's `useRelativeTimeTick` is
 * exactly the re-render that reasoning says it lacks, so a plain recompute
 * here goes stale in a way that one doesn't. */
export function formatRelativeTime(iso: string, now: number, locale?: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = then - now
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  const seconds = Math.round(diffMs / 1000)
  if (Math.abs(seconds) < 60) return rtf.format(seconds, 'second')

  const minutes = Math.round(diffMs / MINUTE_MS)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')

  const hours = Math.round(diffMs / HOUR_MS)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')

  const days = Math.round(diffMs / DAY_MS)
  return rtf.format(days, 'day')
}

/** Minor units (cents) as a locale-formatted currency figure — `extraUsage`'s
 * own amounts are always minor units, per the API's contract. `locale`
 * follows the app's own language (`i18n.language`, threaded down from the
 * page) rather than the runtime's default, the same as every other
 * number/date figure on this page — otherwise a reader in the `ru` UI would
 * see "€12.34" instead of "12,34 €". */
export function formatCurrencyMinor(
  minorUnits: number,
  currency: string | null,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(minorUnits / 100)
}

const WINDOW_LABEL_KEYS: Record<string, string> = {
  five_hour: 'usage.window.five_hour',
  seven_day: 'usage.window.seven_day',
  seven_day_opus: 'usage.window.seven_day_opus',
  seven_day_sonnet: 'usage.window.seven_day_sonnet',
  seven_day_oauth_apps: 'usage.window.seven_day_oauth_apps',
}

/** Which i18n key names a window's own label, or `null` for a key this page
 * has no fixed wording for — the source can report a window key ahead of
 * this page's own list (a new per-model tier, say), and that must still show
 * as *something* (the caller falls back to the raw key) rather than a blank
 * label. A `model` row carries no fixed key of its own here — there can be
 * more than one per response (one per model the source scoped a window to),
 * told apart only by the server's own `label`, so the caller interpolates
 * that into `usage.window.model` itself rather than this function trying to
 * pick a key per model name. */
export function usageWindowLabelKey(key: string): string | null {
  if (key === 'model') return 'usage.window.model'
  return WINDOW_LABEL_KEYS[key] ?? null
}

const KNOWN_BEHAVIORS = new Set([
  'cache_miss',
  'long_context',
  'subagent_heavy',
  'high_parallel',
  'cron',
])

/** The i18n key for one of the five behaviors the brief names, or `null` for
 * anything else — a key the local transcript scan invents later must not
 * silently vanish, so an unknown one falls back to its own raw string in the
 * caller rather than this function guessing at a label for it. */
export function behaviorLabelKey(key: string): string | null {
  return KNOWN_BEHAVIORS.has(key) ? `usage.breakdown.behaviors.${key}` : null
}

const KNOWN_OVERAGE_REASONS = new Set([
  'org_level_disabled',
  'org_level_disabled_until',
  'out_of_credits',
  'overage_not_provisioned',
  'member_level_disabled',
  'seat_tier_level_disabled',
])

/** The i18n key for one of the reason codes the brief names, or `null` to
 * fall back to the raw code — the SDK/event's own reason string is not a
 * fixed enum on this side, so an unrecognised one is shown verbatim rather
 * than silently dropped or mistranslated. */
export function overageReasonKey(reason: string): string | null {
  return KNOWN_OVERAGE_REASONS.has(reason) ? `usage.limits.overage.reason.${reason}` : null
}

/** "allowed" / "not available" for the overage row, or `null` when the
 * source reported no verdict at all (the `overage` object can be non-null
 * while carrying only a reason or `inUse`, per the API's own contract) — a
 * `null` here means the caller omits the status half of the line rather
 * than guessing at one. */
export function overageStatusLabel(
  status: UsageOverageStatusEnumKey | null,
): 'allowed' | 'notAvailable' | null {
  if (status === 'rejected') return 'notAvailable'
  if (status === 'allowed' || status === 'allowed_warning') return 'allowed'
  return null
}

export type AuthDisplay =
  | { kind: 'oauth'; source: string }
  | { kind: 'apiKey' }
  | { kind: 'none' }
  | { kind: 'raw'; value: string }

/** Which of `tokenSource`/`apiKeySource` actually names how this box is
 * authenticated, and how to show it. `tokenSource` wins when it names
 * something real (not null, not the literal `'none'`) — the two are never
 * both meaningfully set at once, but a plain `??` would still read a stray
 * `'none'` string as "nothing to fall back from" and skip a real
 * `apiKeySource` sitting right behind it. */
export function resolveAuthDisplay(
  tokenSource: string | null,
  apiKeySource: string | null,
): AuthDisplay {
  const source = tokenSource && tokenSource !== 'none' ? tokenSource : apiKeySource
  if (!source || source === 'none') return { kind: 'none' }
  if (source === 'CLAUDE_CODE_OAUTH_TOKEN') return { kind: 'oauth', source }
  if (source === 'ANTHROPIC_API_KEY') return { kind: 'apiKey' }
  return { kind: 'raw', value: source }
}

/** "pro" -> "Pro" — the one bit of formatting the Plan row needs; the raw
 * value is already the display-worthy word, just lowercased by the API. */
export function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}
