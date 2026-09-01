import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { HealthBadge } from '@/features/health'
import { ProjectsPage } from '@/features/projects'
import { SshKeysPage } from '@/features/ssh-keys'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { pageAtom, themeAtom } from '@/shared/store/ui'
import { Button } from '@/shared/ui'
import styles from './app.module.scss'

export function App() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useAtom(themeAtom)
  const [page, setPage] = useAtom(pageAtom)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('app.title')}</h1>
          <p className={styles.subtitle}>{t('app.subtitle')}</p>
        </div>
        <div className={styles.controls}>
          <HealthBadge />
          <select
            className={styles.select}
            aria-label={t('language.label')}
            value={i18n.resolvedLanguage}
            onChange={(event) => void i18n.changeLanguage(event.target.value)}
          >
            {SUPPORTED_LANGUAGES.map((lng) => (
              <option key={lng} value={lng}>
                {lng.toUpperCase()}
              </option>
            ))}
          </select>
          <Button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀' : '☾'}
          </Button>
        </div>
      </header>

      <nav className={styles.nav}>
        <button
          type="button"
          className={styles.navItem}
          aria-current={page === 'projects' ? 'page' : undefined}
          onClick={() => setPage('projects')}
        >
          {t('nav.projects')}
        </button>
        <button
          type="button"
          className={styles.navItem}
          aria-current={page === 'ssh-keys' ? 'page' : undefined}
          onClick={() => setPage('ssh-keys')}
        >
          {t('nav.sshKeys')}
        </button>
      </nav>

      <main>{page === 'projects' ? <ProjectsPage /> : <SshKeysPage />}</main>
    </div>
  )
}
