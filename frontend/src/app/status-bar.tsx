import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useHealth } from '@/features/health'
import { useSshKeys } from '@/features/ssh-keys'
import { formatBytes, useSystem } from '@/features/system'
import styles from './layout.module.scss'

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

  return (
    <footer className={styles.status}>
      <span className={styles.statusItem}>
        <span className={`${styles.dot} ${styles[state]}`} aria-hidden="true" />
        {label}
      </span>

      {/* Which project you are in is the tab bar's job now, so the status bar
          says nothing about it: repeating it here would be a second, slower
          answer to a question already answered above. */}
      {keys && (
        <Link to="/ssh-keys" className={`${styles.statusItem} ${styles.statusLink}`}>
          {t('status.keys', { count: keys.length })}
        </Link>
      )}

      {/* Host load. Three figures, pushed to the right with the version: enough
          to notice the box filling up or pinned, without becoming a dashboard. */}
      {system && (
        <>
          <span
            className={`${styles.statusItem} ${styles.statusSpacer} ${styles.metric}`}
            title={t('status.cpuTitle', { cores: system.cpu.cores, load: system.cpu.load1 })}
          >
            {t('status.cpu', { percent: Math.round(system.cpu.usagePercent) })}
          </span>
          <span
            className={`${styles.statusItem} ${styles.metric} ${system.memory.usedPercent >= 90 ? styles.metricHigh : ''}`}
            title={t('status.memTitle', {
              used: formatBytes(system.memory.usedBytes),
              total: formatBytes(system.memory.totalBytes),
            })}
          >
            {t('status.mem', {
              used: formatBytes(system.memory.usedBytes),
              percent: Math.round(system.memory.usedPercent),
            })}
          </span>
          <span
            className={`${styles.statusItem} ${styles.metric} ${system.disk.usedPercent >= 90 ? styles.metricHigh : ''}`}
            title={t('status.diskTitle', {
              path: system.disk.path,
              free: formatBytes(system.disk.totalBytes - system.disk.usedBytes),
            })}
          >
            {t('status.disk', { percent: Math.round(system.disk.usedPercent) })}
          </span>
        </>
      )}

      <span className={`${styles.statusItem} ${!system ? styles.statusSpacer : ''}`}>
        {health?.version ? `v${health.version}` : ''}
      </span>
    </footer>
  )
}
