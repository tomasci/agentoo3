import { CircleAlertIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import type { UsageAccount } from '@/shared/api/generated/types/UsageAccount'
import type { UsageBreakdown } from '@/shared/api/generated/types/UsageBreakdown'
import type { UsageExtraUsage } from '@/shared/api/generated/types/UsageExtraUsage'
import type { UsageLimits } from '@/shared/api/generated/types/UsageLimits'
import type { UsageNamedShare } from '@/shared/api/generated/types/UsageNamedShare'
import type { UsageOverage } from '@/shared/api/generated/types/UsageOverage'
import type { UsagePeriod } from '@/shared/api/generated/types/UsagePeriod'
import type { UsageWindow } from '@/shared/api/generated/types/UsageWindow'
import {
  type DefinitionItem,
  DefinitionList,
  Loading,
  PageHeader,
  StatusBadge,
} from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Progress } from '@/shared/ui/progress'
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { useRelativeTimeTick, useUsage } from '../hooks/use-usage'
import {
  behaviorLabelKey,
  capitalize,
  displayPercent,
  formatCurrencyMinor,
  formatDurationShort,
  formatRelativeTime,
  hasWindowReset,
  type MeterLevel,
  meterLevel,
  overageReasonKey,
  overageStatusLabel,
  resolveAuthDisplay,
  roundPercent,
  type Translate,
  usageWindowLabelKey,
} from '../lib/usage'

type Period = 'day' | 'week'

/** The Progress indicator's colour for one of the three emphasis levels
 * `meterLevel` names, or a muted grey when `muted` overrides all of them —
 * the same descendant-selector trick `status-bar.tsx`'s own `HostMetric`
 * uses to reach the indicator without hand-editing `ui/progress.tsx`. */
function meterIndicatorClass(level: MeterLevel, muted = false): string {
  if (muted) return '**:data-[slot=progress-indicator]:bg-muted-foreground/40'
  if (level === 'critical') return '**:data-[slot=progress-indicator]:bg-destructive'
  if (level === 'warning') {
    return '**:data-[slot=progress-indicator]:bg-amber-500 dark:**:data-[slot=progress-indicator]:bg-amber-400'
  }
  return ''
}

/** Which translated string names one window's row — `model` rows carry no
 * fixed key of their own (there can be more than one, told apart by the
 * server's own `label`, itself sometimes null) and every other key is only
 * ever one of a fixed, known set, but neither of those things is guaranteed
 * to still hold once the source adds a window this page does not know about
 * yet, so both fall back to something visible rather than a blank label:
 * an unrecognised fixed key shows its own raw string, and a `model` row with
 * no server-supplied name shows a generic `usage.window.modelFallback`
 * rather than leaving the "Weekly · " prefix dangling with nothing after
 * it. */
function windowLabel(window: UsageWindow, t: Translate): string {
  if (window.key === 'model') {
    return t('usage.window.model', { label: window.label || t('usage.window.modelFallback') })
  }
  const key = usageWindowLabelKey(window.key)
  return key ? t(key) : window.key
}

/**
 * One rate-limit window: its label, percent, a meter, and a reset countdown.
 *
 * A `null` `utilization` renders the meter at 0 rather than passing `null`
 * through to `Progress` itself — Base UI's own `Progress` reads a `null`
 * value as *indeterminate* and renders the indicator at its default 100%
 * width (`ui/progress.tsx`'s indicator carries no width class of its own;
 * the percentage is the only thing that ever constrains it), which would
 * read as "fully used" for the one case that means the opposite: nothing
 * known yet.
 */
function WindowMeter({
  window,
  now,
  locale,
}: {
  window: UsageWindow
  now: number
  locale: string
}) {
  const { t } = useTranslation()
  const stale = hasWindowReset(window.resetsAt, now)
  const rounded = window.utilization != null ? displayPercent(window.utilization) : null
  const level = rounded != null ? meterLevel(rounded) : 'normal'
  const label = windowLabel(window, t)
  const resetsAtMs = window.resetsAt ? new Date(window.resetsAt).getTime() : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate font-medium" title={label}>
          {label}
        </span>
        <span className={cn('shrink-0 tabular-nums', stale && 'text-muted-foreground')}>
          {rounded == null ? '—' : `${rounded}%`}
        </span>
      </div>
      <Progress value={rounded ?? 0} className={meterIndicatorClass(level, stale)} />
      {window.resetsAt &&
        (stale ? (
          <span className="text-xs text-muted-foreground">
            {t('usage.window.resetSinceReport')}
          </span>
        ) : (
          <Tooltip>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a read-only
                figure with nothing to activate — see status-bar.tsx's
                `HostMetric`, whose `TooltipTrigger` carries the same
                comment for the same reason: Base UI opens a tooltip on
                trigger focus, not on an unfocusable one made focusable
                for it. */}
            <TooltipTrigger render={<span tabIndex={0} className="w-fit" />}>
              <span className="text-xs text-muted-foreground">
                {t('usage.window.resetsIn', {
                  duration: formatDurationShort((resetsAtMs ?? now) - now, t),
                })}
              </span>
            </TooltipTrigger>
            <TooltipContent>{new Date(window.resetsAt).toLocaleString(locale)}</TooltipContent>
          </Tooltip>
        ))}
    </div>
  )
}

/** The overage-credit line: only ever populated for `source: 'observed'` —
 * see `UsageOverage`'s own doc comment — and, even there, any of its three
 * fields can be the only one actually set, so each renders independently
 * rather than assuming the other two are present alongside it. */
function OverageRow({ overage }: { overage: NonNullable<UsageOverage> }) {
  const { t } = useTranslation()
  const statusLabel = overageStatusLabel(overage.status)
  const reasonKey = overage.disabledReason ? overageReasonKey(overage.disabledReason) : null
  const reasonText = overage.disabledReason
    ? reasonKey
      ? t(reasonKey)
      : overage.disabledReason
    : null

  // The "Extra usage:" lead-in always renders, even when the source gave no
  // verdict (a null `status`) and this row has only a reason and/or `inUse`
  // to show — the reason on its own, with nothing naming what it is a reason
  // for, used to render as a dangling " — Out of credits". With a status,
  // the reason trails it behind an em dash (as it always did); without one,
  // the reason stands in directly for the missing status half of the line,
  // so no dash is left pointing at nothing.
  const parts = [
    statusLabel
      ? t('usage.limits.overage.line', { status: t(`usage.limits.overage.${statusLabel}`) })
      : t('usage.limits.overage.linePrefix'),
  ]
  if (reasonText) parts.push(statusLabel ? `— ${reasonText}` : reasonText)
  if (overage.inUse) parts.push(`(${t('usage.limits.overage.inUse')})`)

  return <p className="text-sm text-muted-foreground">{parts.join(' ')}</p>
}

/** Pay-as-you-go overage spend — only ever populated for `source: 'live'`
 * (see `UsageExtraUsage`'s own doc comment); `isEnabled: false` is its own
 * state rather than a meter at 0%, since a disabled plan has no percentage
 * to speak of at all. */
function ExtraUsageRow({
  extraUsage,
  locale,
}: {
  extraUsage: NonNullable<UsageExtraUsage>
  locale: string
}) {
  const { t } = useTranslation()
  const rounded = extraUsage.utilization != null ? displayPercent(extraUsage.utilization) : null
  const level = rounded != null ? meterLevel(rounded) : 'normal'

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{t('usage.limits.extraUsage.heading')}</span>
      {!extraUsage.isEnabled ? (
        <p className="text-sm text-muted-foreground">{t('usage.limits.extraUsage.disabled')}</p>
      ) : (
        <>
          <Progress value={rounded ?? 0} className={meterIndicatorClass(level)} />
          {extraUsage.usedCredits != null && extraUsage.monthlyLimit != null && (
            <p className="text-sm text-muted-foreground">
              {t('usage.limits.extraUsage.amount', {
                used: formatCurrencyMinor(extraUsage.usedCredits, extraUsage.currency, locale),
                limit: formatCurrencyMinor(extraUsage.monthlyLimit, extraUsage.currency, locale),
              })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Plan limits: one meter per rate-limit window, the source line explaining
 * how fresh that reading is, and the two credit add-ons (`overage`,
 * `extraUsage`) that only ever appear for one `source` each.
 */
function PlanLimitsCard({
  limits,
  now,
  locale,
}: {
  limits: UsageLimits
  now: number
  locale: string
}) {
  const { t } = useTranslation()
  const badge =
    limits.status === 'rejected' ? (
      <StatusBadge tone="danger">{t('usage.limits.status.rejected')}</StatusBadge>
    ) : limits.status === 'allowed_warning' ? (
      <StatusBadge tone="warning">{t('usage.limits.status.warning')}</StatusBadge>
    ) : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('usage.limits.heading')}</CardTitle>
        {badge && <CardAction>{badge}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {limits.source === 'none' ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('usage.limits.source.none')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              {limits.windows.map((window, index) => (
                <WindowMeter
                  key={`${window.key}-${window.label ?? index}`}
                  window={window}
                  now={now}
                  locale={locale}
                />
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {limits.source === 'live' ? (
                <p className="text-sm text-muted-foreground">{t('usage.limits.source.live')}</p>
              ) : (
                limits.asOf && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t('usage.limits.source.observed', {
                        relative: formatRelativeTime(limits.asOf, now, locale),
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('usage.limits.source.observedNote')}
                    </p>
                  </>
                )
              )}
            </div>
          </>
        )}

        {limits.overage && <OverageRow overage={limits.overage} />}
        {limits.extraUsage && <ExtraUsageRow extraUsage={limits.extraUsage} locale={locale} />}
      </CardContent>
    </Card>
  )
}

/** Which `usage.account.*` string names how this box is authenticated — the
 * one row here built outside the component tree, since `resolveAuthDisplay`
 * is a plain value, not JSX, and reads better assembled once than inlined
 * into the definition list below. */
function authText(account: NonNullable<UsageAccount>, t: Translate): string {
  const display = resolveAuthDisplay(account.tokenSource, account.apiKeySource)
  switch (display.kind) {
    case 'oauth':
      return t('usage.account.authOAuth', { source: display.source })
    case 'apiKey':
      return t('usage.account.authApiKey')
    case 'raw':
      return display.value
    case 'none':
      return '—'
  }
}

/** Plan and Authentication always appear (each has its own null wording);
 * Provider, Email and Organization are omitted outright when the account
 * carries no value for them — there is no honest fallback word for "this
 * box has no organization" the way "Unknown" works for an absent plan. */
function accountItems(account: NonNullable<UsageAccount>, t: Translate): DefinitionItem[] {
  const items: DefinitionItem[] = [
    {
      id: 'plan',
      term: t('usage.account.plan'),
      description: account.subscriptionType
        ? capitalize(account.subscriptionType)
        : t('usage.account.unknownPlan'),
    },
    { id: 'auth', term: t('usage.account.authentication'), description: authText(account, t) },
  ]
  if (account.apiProvider) {
    items.push({
      id: 'provider',
      term: t('usage.account.provider'),
      description:
        account.apiProvider === 'firstParty'
          ? t('usage.account.providerAnthropic')
          : account.apiProvider,
    })
  }
  if (account.email) {
    items.push({ id: 'email', term: t('usage.account.email'), description: account.email })
  }
  if (account.organization) {
    items.push({
      id: 'organization',
      term: t('usage.account.organization'),
      description: account.organization,
    })
  }
  return items
}

function AccountCard({ account }: { account: UsageAccount }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('usage.account.heading')}</CardTitle>
      </CardHeader>
      <CardContent>
        {account ? (
          <DefinitionList items={accountItems(account, t)} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('usage.account.unavailable')}</p>
        )}
      </CardContent>
    </Card>
  )
}

/** One named share (an agent, a skill, a plugin, an MCP server) as a labelled
 * meter — hidden outright when the list is empty, rather than a heading over
 * nothing: the brief's own "hide an empty list" for exactly this. */
function NamedShareList({ title, items }: { title: string; items: UsageNamedShare[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{item.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {roundPercent(item.pct)}%
              </span>
            </div>
            <Progress value={roundPercent(item.pct)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function BreakdownBody({ period }: { period: UsagePeriod }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t('usage.breakdown.requests', {
          requests: t('usage.breakdown.requestsCount', { count: period.requestCount }),
          sessions: t('usage.breakdown.sessionsCount', { count: period.sessionCount }),
        })}
      </p>
      {period.behaviors.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('usage.breakdown.behaviors.heading')}</h3>
          <ul className="flex flex-col gap-2">
            {period.behaviors.map((entry) => {
              const key = behaviorLabelKey(entry.key)
              return (
                <li key={entry.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{key ? t(key) : entry.key}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {roundPercent(entry.pct)}% · {entry.count}
                    </span>
                  </div>
                  <Progress value={roundPercent(entry.pct)} />
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t('usage.breakdown.behaviors.note')}</p>
        </div>
      )}
      <NamedShareList title={t('usage.breakdown.agents')} items={period.agents} />
      <NamedShareList title={t('usage.breakdown.skills')} items={period.skills} />
      <NamedShareList title={t('usage.breakdown.plugins')} items={period.plugins} />
      <NamedShareList title={t('usage.breakdown.mcpServers')} items={period.mcpServers} />
      <p className="text-xs text-muted-foreground">{t('usage.breakdown.footnote')}</p>
    </>
  )
}

function BreakdownCard({
  breakdown,
  period,
  onPeriodChange,
}: {
  breakdown: UsageBreakdown
  period: Period
  onPeriodChange: (period: Period) => void
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('usage.breakdown.heading')}</CardTitle>
        {breakdown && (
          <CardAction>
            <ToggleGroup
              aria-label={t('usage.breakdown.period.label')}
              variant="outline"
              value={[period]}
              onValueChange={(next) => {
                // Base UI reports a single-select group's click as a
                // 0-or-1-length array — see ports-page.tsx's identical scope
                // toggle for why the already-pressed case (the empty array)
                // must leave `period` exactly where it was.
                const value = next[0]
                if (value === 'day' || value === 'week') onPeriodChange(value)
              }}
            >
              <ToggleGroupItem value="day">{t('usage.breakdown.period.day')}</ToggleGroupItem>
              <ToggleGroupItem value="week">{t('usage.breakdown.period.week')}</ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {breakdown ? (
          <BreakdownBody period={breakdown[period]} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('usage.breakdown.unavailable')}</p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The System tab's Usage page: the Claude subscription's plan limits (with
 * how stale that reading is made explicit — see `PlanLimitsCard`), the
 * account Claude Code is authenticated as, and what has been consuming that
 * usage, from a local scan of this machine's own transcripts.
 *
 * Polled every 60s (`useUsage`'s own comment says why), with a Refresh
 * button for "right now" — and a second, independent 30s ticker
 * (`useRelativeTimeTick`) that re-renders the page on its own so the reset
 * countdowns and "reported N ago" line keep counting between polls instead
 * of jumping once a minute.
 */
export function UsagePage() {
  const { t, i18n } = useTranslation()
  const usage = useUsage()
  useRelativeTimeTick()
  const [period, setPeriod] = useState<Period>('day')
  const now = Date.now()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('usage.heading')}
        description={t('usage.lead')}
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={usage.isFetching}
            onClick={() => void usage.refetch()}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(usage.isFetching && 'animate-spin')}
            />
            {t('usage.refresh')}
          </Button>
        }
      />

      {usage.isError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{apiErrorMessage(usage.error, t('usage.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {usage.isPending && <Loading label={t('common.loading')} block />}

      {usage.data && (
        <div className="flex flex-col gap-6">
          {usage.data.probeError && (
            <Alert role="status">
              <TriangleAlertIcon />
              <AlertDescription>{usage.data.probeError}</AlertDescription>
            </Alert>
          )}

          <PlanLimitsCard limits={usage.data.limits} now={now} locale={i18n.language} />
          <AccountCard account={usage.data.account} />
          <BreakdownCard
            breakdown={usage.data.breakdown}
            period={period}
            onPeriodChange={setPeriod}
          />

          <p className="text-xs text-muted-foreground">
            {t('usage.updated', {
              time: new Date(usage.data.fetchedAt).toLocaleTimeString(i18n.language),
            })}
          </p>
        </div>
      )}
    </div>
  )
}
