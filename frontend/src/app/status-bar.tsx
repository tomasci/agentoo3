import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useHealth } from '@/features/health'
import { useSshKeys } from '@/features/ssh-keys'
import { formatBytes, useSystem } from '@/features/system'
import { StatusDot, Tooltip } from '@/shared/ui'
import styles from './layout.module.scss'

// StatusDot only speaks in the five shared tones — 'down' covers both "still
// checking" and "actually unreachable", so it reads as neutral rather than
// alarming: a slow health check should not look identical to a real failure.
const DOT_TONE = {
  ok: 'success',
  warn: 'warning',
  down: 'neutral',
} as const

type MetricKey = 'cpu' | 'mem' | 'disk'

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
 * The IDE-style strip along the bottom.
 *
 * Everything here answers "is this thing working", which is what a status bar is
 * for — a reader should never have to open a page to find out the backend is
 * down or that agents cannot run.
 */
export function StatusBar() {
  const { t } = useTranslation()
  const { data: health, isPending, isError } = useHealth()
  const { data: keys } = useSshKeys()
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
  const worstLabel = worst
    ? worst.key === 'cpu'
      ? t('status.cpu', { percent: Math.round(worst.percent) })
      : worst.key === 'mem'
        ? t('status.memPercent', { percent: Math.round(worst.percent) })
        : t('status.disk', { percent: Math.round(worst.percent) })
    : ''

  return (
    <footer className={styles.status}>
      {/* min-width: 0 so this — not the version at the far end — is the item
          that gives way and truncates when the row is too narrow to fit
          everything; see layout.module.scss for why. */}
      <span className={`${styles.statusItem} ${styles.statusHealth}`}>
        <StatusDot tone={DOT_TONE[state]} />
        <span className={styles.statusHealthLabel}>{label}</span>
      </span>

      {/* Which project you are in is the tab bar's job now, so the status bar
          says nothing about it: repeating it here would be a second, slower
          answer to a question already answered above. Hidden on a phone: it
          is navigation, not status, and the system sidebar already links to
          /ssh-keys — and it is also the widest item here that isn't. */}
      {keys && (
        <Link to="/ssh-keys" className={`${styles.statusItem} ${styles.statusLink}`}>
          {t('status.keys', { count: keys.length })}
        </Link>
      )}

      {/* Host load. Three figures, pushed to the right with the version: enough
          to notice the box filling up or pinned, without becoming a dashboard.
          Each figure's detail lives in a Tooltip rather than `title=`, which
          never reaches a keyboard user; the visible text stays styled on its
          own wrapper so the tooltip's own trigger — the part that must not
          carry a className, per the component contract — can stay a plain,
          focusable span. On a phone all three collapse into one untooltipped
          chip below: a tooltip is useless on touch, and there is no room for
          three figures anyway. */}
      {system && (
        <>
          <span className={styles.statusMetrics}>
            <span className={`${styles.statusItem} ${styles.statusSpacer} ${styles.metric}`}>
              <Tooltip
                content={t('status.cpuTitle', { cores: system.cpu.cores, load: system.cpu.load1 })}
              >
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                    text with nothing to activate — a button would promise
                    interactivity that isn't there. It still needs a stop in the
                    tab order, because Ark's Tooltip opens on trigger focus, not
                    by making an unfocusable trigger focusable for you. */}
                <span tabIndex={0}>
                  {t('status.cpu', { percent: Math.round(system.cpu.usagePercent) })}
                </span>
              </Tooltip>
            </span>
            <span
              className={`${styles.statusItem} ${styles.metric} ${system.memory.usedPercent >= 90 ? styles.metricHigh : ''}`}
            >
              <Tooltip
                content={t('status.memTitle', {
                  used: formatBytes(system.memory.usedBytes),
                  total: formatBytes(system.memory.totalBytes),
                })}
              >
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                    text with nothing to activate — a button would promise
                    interactivity that isn't there. It still needs a stop in the
                    tab order, because Ark's Tooltip opens on trigger focus, not
                    by making an unfocusable trigger focusable for you. */}
                <span tabIndex={0}>
                  {t('status.mem', {
                    used: formatBytes(system.memory.usedBytes),
                    percent: Math.round(system.memory.usedPercent),
                  })}
                </span>
              </Tooltip>
            </span>
            <span
              className={`${styles.statusItem} ${styles.metric} ${system.disk.usedPercent >= 90 ? styles.metricHigh : ''}`}
            >
              <Tooltip
                content={t('status.diskTitle', {
                  path: system.disk.path,
                  free: formatBytes(system.disk.totalBytes - system.disk.usedBytes),
                })}
              >
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: read-only status
                    text with nothing to activate — a button would promise
                    interactivity that isn't there. It still needs a stop in the
                    tab order, because Ark's Tooltip opens on trigger focus, not
                    by making an unfocusable trigger focusable for you. */}
                <span tabIndex={0}>
                  {t('status.disk', { percent: Math.round(system.disk.usedPercent) })}
                </span>
              </Tooltip>
            </span>
          </span>

          <span
            className={`${styles.statusItem} ${styles.statusSpacer} ${styles.metric} ${styles.statusSummary} ${worst && worst.percent >= 90 ? styles.metricHigh : ''}`}
          >
            {worstLabel}
          </span>
        </>
      )}

      <span className={`${styles.statusItem} ${!system ? styles.statusSpacer : ''}`}>
        {health?.version ? `v${health.version}` : ''}
      </span>
    </footer>
  )
}
