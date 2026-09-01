import { Link, Outlet } from '@tanstack/react-router'
import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { themeAtom } from '@/shared/store/ui'
import { Button } from '@/shared/ui'
import styles from './layout.module.scss'
import { StatusBar } from './status-bar'

export function RootLayout() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useAtom(themeAtom)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link to="/projects" className={styles.brand}>
          <h1 className={styles.logo}>{t('app.title')}</h1>
          <p className={styles.tagline}>{t('app.subtitle')}</p>
        </Link>

        <nav className={styles.nav}>
          {/* activeOptions exact:false keeps Projects lit while you are inside
              a project, since /projects/$id sits under it. */}
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

        {/* Preferences, not navigation, so they sit at the foot. */}
        <div className={styles.sidebarFoot}>
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
          <Button
            type="button"
            aria-label={t('theme.toggle')}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </Button>
        </div>
      </aside>

      <main className={styles.body}>
        <Outlet />
      </main>

      <StatusBar />
    </div>
  )
}
