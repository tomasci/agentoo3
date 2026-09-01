import { Link, Outlet } from '@tanstack/react-router'
import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { HealthBadge } from '@/features/health'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { themeAtom } from '@/shared/store/ui'
import { Button } from '@/shared/ui'
import styles from './app.module.scss'

/** Chrome shared by every page: header, nav, theme and language. */
export function RootLayout() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useAtom(themeAtom)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link to="/projects" className={styles.brand}>
            <h1 className={styles.title}>{t('app.title')}</h1>
          </Link>
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
        {/* activeProps rather than manual comparison: a project page is under
            /projects, so `fuzzy` keeps the tab lit while you are inside one. */}
        <Link
          to="/projects"
          className={styles.navItem}
          activeProps={{ 'aria-current': 'page' }}
          activeOptions={{ exact: false }}
        >
          {t('nav.projects')}
        </Link>
        <Link to="/ssh-keys" className={styles.navItem} activeProps={{ 'aria-current': 'page' }}>
          {t('nav.sshKeys')}
        </Link>
      </nav>

      <main>
        <Outlet />
      </main>
    </div>
  )
}
