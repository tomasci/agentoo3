import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useHealth } from '@/features/health'
import { useCurrentProject, useProjects } from '@/features/projects'
import { useSshKeys } from '@/features/ssh-keys'
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
  const { data: projects } = useProjects()
  const { current } = useCurrentProject()
  const { data: keys } = useSshKeys()

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

      {current ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: current.id }}
          className={`${styles.statusItem} ${styles.statusLink}`}
        >
          {t('status.project', { name: current.name })}
        </Link>
      ) : (
        projects && (
          <Link to="/projects" className={`${styles.statusItem} ${styles.statusLink}`}>
            {t('projects.count', { count: projects.length })}
          </Link>
        )
      )}

      {keys && (
        <Link to="/ssh-keys" className={`${styles.statusItem} ${styles.statusLink}`}>
          {t('status.keys', { count: keys.length })}
        </Link>
      )}

      <span className={`${styles.statusItem} ${styles.statusSpacer}`}>
        {health?.version ? `v${health.version}` : ''}
      </span>
    </footer>
  )
}
