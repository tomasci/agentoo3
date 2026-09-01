import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { useHealth } from '../hooks/use-health'
import styles from './status-card.module.scss'

export function StatusCard() {
  const { t } = useTranslation()
  const { data, isPending, isError, refetch, isFetching } = useHealth()

  const state = isPending ? 'pending' : data ? 'online' : 'offline'
  const label = isPending ? t('status.loading') : data ? t('status.online') : t('status.offline')

  return (
    <section className={styles.card}>
      <h2 className={styles.heading}>{t('status.heading')}</h2>
      <div className={styles.row}>
        <span className={`${styles.dot} ${styles[state]}`} aria-hidden="true" />
        <span>{label}</span>
      </div>
      {isError && <p className={styles.hint}>{t('status.hint')}</p>}
      <div className={styles.retry}>
        <Button type="button" onClick={() => void refetch()} disabled={isFetching}>
          {t('status.retry')}
        </Button>
      </div>
    </section>
  )
}
