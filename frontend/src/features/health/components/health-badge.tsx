import { useTranslation } from 'react-i18next'
import { useHealth } from '../hooks/use-health'
import styles from './health-badge.module.scss'

export function HealthBadge() {
  const { t } = useTranslation()
  const { data, isPending, isError } = useHealth()

  // Three distinct states, because "backend down" and "backend up but agents
  // cannot run" need different actions from the reader.
  const state = isPending
    ? 'down'
    : isError || !data
      ? 'down'
      : data.claudeCredential
        ? 'ok'
        : 'warn'
  const label = isPending
    ? t('health.checking')
    : isError || !data
      ? t('health.down')
      : data.claudeCredential
        ? t('health.ok')
        : t('health.noCredential')

  return (
    <span className={styles.badge} title={label}>
      <span className={`${styles.dot} ${styles[state]}`} aria-hidden="true" />
      {label}
    </span>
  )
}
