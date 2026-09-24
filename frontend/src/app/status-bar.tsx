import { useTranslation } from 'react-i18next'
import { useHealth } from '@/features/health'
import { formatBytes, useSystem } from '@/features/system'
import { StatusDot, type Tone } from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { buttonVariants } from '@/shared/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/shared/ui/popover'
import { Progress, ProgressLabel, ProgressValue } from '@/shared/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

// StatusDot only speaks in the five shared tones — 'neutral' covers both
// "still checking" and "actually unreachable", so it reads as neutral rather
// than alarming: a slow health check should not look identical to a real
// failure.
const DOT_TONE: Record<'ok' | 'warn' | 'down', Tone> = {
  ok: 'success',
  warn: 'warning',
  down: 'neutral',
}

type MetricKey = 'cpu' | 'mem' | 'disk'

/** The short label each figure's Progress bar carries as its accessible name. */
const METRIC_LABEL_KEY: Record<MetricKey, string> = {
  cpu: 'status.cpuLabel',
  mem: 'status.memLabel',
  disk: 'status.diskLabel',
}

/**
 * Which of the three host figures is under the most pressure, so the phone
 * chip can name just that one instead of three tooltip-only figures with no
 * room to show any of them properly.
 */
function worstMetric(cpuPercent: number, memPercent: number, diskPercent: number) {
  const candidates: Array<{ key: MetricKey; percent: number }> = [
    { key: 'cpu', percent: cpuPercent },
    { key: 'mem', percent: memPercent },
    { key: 'disk', percent: diskPercent },
  ]
  return candidates.reduce((worst, candidate) =>
    candidate.percent > worst.percent ? candidate : worst,
  )
}

/**
 * One host figure — CPU, RAM or Disk — as a Progress bar: label, value and
 * the bar itself. `className` sizes it per call site (a fixed width in the
 * footer strip so the row doesn't jitter as the numbers change, full width
 * inside the phone popover's list of three).
 *
 * The bar recolours at ≥90% and the label/value text does not — an operator
 * exception to "don't restyle a shadcn component" (frontend/README.md,
 * "Styling"), the same one `StatusDot` carries: the default `bg-primary`
 * indicator and a `text-destructive` label were judged too loud for a strip
 * that live-updates constantly. `ui/progress.tsx` doesn't expose the
 * indicator's own className, so the descendant variant below is the only way
 * to reach it without hand-editing generated code.
 */
function HostMetric({
  label,
  percent,
  locale,
  className,
}: {
  label: string
  percent: number
  locale: string
  className?: string
}) {
  const rounded = Math.round(percent)
  const high = rounded >= 90
  return (
    <Progress
      value={rounded}
      locale={locale}
      className={cn(
        'flex-nowrap items-center gap-1.5',
        high
          ? '**:data-[slot=progress-indicator]:bg-destructive/50'
          : '**:data-[slot=progress-indicator]:bg-muted-foreground/40',
        className,
      )}
    >
      <ProgressLabel className="text-xs">{label}</ProgressLabel>
      <ProgressValue className="text-xs" />
    </Progress>
  )
}

/**
 * The IDE-style strip along the bottom.
 *
 * Everything here answers "is this thing working", which is what a status bar is
 * for — a reader should never have to open a page to find out the backend is
 * down or that agents cannot run. No background or border of its own: it sits
 * on the same `bg-sidebar` surface as the sidebar and the tab bar (see
 * root-layout.tsx).
 */
export function StatusBar() {
  const { t, i18n } = useTranslation()
  const { data: health, isPending, isError } = useHealth()
  const { data: system } = useSystem()

  // Three states, because "backend down" and "backend up but agents cannot run"
  // call for different actions.
  const state = isPending
    ? 'down'
    : isError || !health
      ? 'down'
      : health.claudeCredential
        ? 'ok'
        : 'warn'
  const label = isPending
    ? t('health.checking')
    : isError || !health
      ? t('health.down')
      : health.claudeCredential
        ? t('health.ok')
        : t('health.noCredential')

  const worst = system
    ? worstMetric(system.cpu.usagePercent, system.memory.usedPercent, system.disk.usedPercent)
    : null

  // Computed once and shared by the desktop tooltips and the phone popover,
  // which both need to say the same thing about the same figure.
  const cpuDetail = system
    ? t('status.cpuTitle', { cores: system.cpu.cores, load: system.cpu.load1 })
    : ''
  const memDetail = system
    ? t('status.memTitle', {
        used: formatBytes(system.memory.usedBytes),
        total: formatBytes(system.memory.totalBytes),
      })
    : ''
  const diskDetail = system
    ? t('status.diskTitle', {
        path: system.disk.path,
        free: formatBytes(system.disk.totalBytes - system.disk.usedBytes),
      })
    : ''

  return (
    <footer className="flex min-h-8 shrink-0 items-center gap-3 px-4 pb-[env(safe-area-inset-bottom)] text-xs text-muted-foreground">
      {/* min-w-0 so this — not the version at the far end — is the item that
          gives way and truncates when the row is too narrow to fit
          everything. */}
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <StatusDot tone={DOT_TONE[state]} />
        <span className="truncate">{label}</span>
      </span>

      {/* Host load. Three Progress bars, pushed to the right with the version:
          enough to notice the box filling up or pinned, without becoming a
          dashboard. Each bar's detail lives in a Tooltip rather than `title=`,
          which never reaches a keyboard user; the trigger wrapping it stays a
          plain, focusable, non-interactive element. On a phone all three
          collapse into one Progress below, naming just the worst metric — a
          tooltip is useless on touch and there is no room for three bars
          anyway, so that one is a real button that opens a Popover with the
          same three figures and detail lines instead. */}
      {system && (
        <>
          <span className="ml-auto hidden shrink-0 items-center gap-3 md:flex">
            <Tooltip>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                  figure with nothing to activate — a button would promise
                  interactivity that isn't there. It still needs a stop in the
                  tab order, because Base UI's Tooltip opens on trigger focus,
                  not by making an unfocusable trigger focusable for you. */}
              <TooltipTrigger render={<div tabIndex={0} />}>
                <HostMetric
                  label={t('status.cpuLabel')}
                  percent={system.cpu.usagePercent}
                  locale={i18n.language}
                  className="w-32"
                />
              </TooltipTrigger>
              <TooltipContent>{cpuDetail}</TooltipContent>
            </Tooltip>
            <Tooltip>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                  figure with nothing to activate — a button would promise
                  interactivity that isn't there. It still needs a stop in the
                  tab order, because Base UI's Tooltip opens on trigger focus,
                  not by making an unfocusable trigger focusable for you. */}
              <TooltipTrigger render={<div tabIndex={0} />}>
                <HostMetric
                  label={t('status.memLabel')}
                  percent={system.memory.usedPercent}
                  locale={i18n.language}
                  className="w-32"
                />
              </TooltipTrigger>
              <TooltipContent>{memDetail}</TooltipContent>
            </Tooltip>
            <Tooltip>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                  figure with nothing to activate — a button would promise
                  interactivity that isn't there. It still needs a stop in the
                  tab order, because Base UI's Tooltip opens on trigger focus,
                  not by making an unfocusable trigger focusable for you. */}
              <TooltipTrigger render={<div tabIndex={0} />}>
                <HostMetric
                  label={t('status.diskLabel')}
                  percent={system.disk.usedPercent}
                  locale={i18n.language}
                  className="w-32"
                />
              </TooltipTrigger>
              <TooltipContent>{diskDetail}</TooltipContent>
            </Tooltip>
          </span>

          <span className="ml-auto shrink-0 md:hidden">
            {worst && (
              <Popover>
                <PopoverTrigger
                  aria-label={t('status.hostDetails')}
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'xs' }),
                    'h-auto px-1.5 py-1 font-normal',
                  )}
                >
                  <HostMetric
                    label={t(METRIC_LABEL_KEY[worst.key])}
                    percent={worst.percent}
                    locale={i18n.language}
                    className="w-32"
                  />
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-64">
                  <PopoverHeader>
                    <PopoverTitle>{t('status.hostDetails')}</PopoverTitle>
                  </PopoverHeader>
                  <div className="flex flex-col gap-2.5">
                    <div>
                      <HostMetric
                        label={t('status.cpuLabel')}
                        percent={system.cpu.usagePercent}
                        locale={i18n.language}
                        className="w-full"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">{cpuDetail}</p>
                    </div>
                    <div>
                      <HostMetric
                        label={t('status.memLabel')}
                        percent={system.memory.usedPercent}
                        locale={i18n.language}
                        className="w-full"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">{memDetail}</p>
                    </div>
                    <div>
                      <HostMetric
                        label={t('status.diskLabel')}
                        percent={system.disk.usedPercent}
                        locale={i18n.language}
                        className="w-full"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">{diskDetail}</p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </span>
        </>
      )}

      <span className={cn('shrink-0', !system && 'ml-auto')}>
        {health?.version ? `v${health.version}` : ''}
      </span>
    </footer>
  )
}
