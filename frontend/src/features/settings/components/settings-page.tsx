import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { themeAtom } from '@/shared/store/ui'
import styles from './settings-page.module.scss'

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ru: 'Русский' }

/**
 * Installation-wide preferences, and only those — a project tab has no business
 * changing the language of the whole app, which is why this page lives in the
 * system tab rather than in a corner of every sidebar.
 *
 * Both settings are held in the browser rather than on the server: they describe
 * how one reader wants to see this installation, not how it is configured.
 */
export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useAtom(themeAtom)

  return (
    <div className={styles.page}>
      <header>
        <h2 className={styles.title}>{t('settings.heading')}</h2>
        <p className={styles.lead}>{t('settings.lead')}</p>
      </header>

      <section className={styles.card}>
        <div className={styles.setting}>
          <label className={styles.label} htmlFor="settings-language">
            {t('settings.language')}
            <span className={styles.hint}>{t('settings.languageHint')}</span>
          </label>
          <select
            id="settings-language"
            className={styles.control}
            value={i18n.resolvedLanguage}
            onChange={(event) => void i18n.changeLanguage(event.target.value)}
          >
            {SUPPORTED_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_NAMES[language] ?? language.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.setting}>
          <label className={styles.label} htmlFor="settings-theme">
            {t('settings.theme')}
            <span className={styles.hint}>{t('settings.themeHint')}</span>
          </label>
          {/* A select rather than the old icon toggle: a two-state button never
              says which state it is in, only which way it will flip. */}
          <select
            id="settings-theme"
            className={styles.control}
            value={theme}
            onChange={(event) => setTheme(event.target.value === 'light' ? 'light' : 'dark')}
          >
            <option value="dark">{t('settings.themeDark')}</option>
            <option value="light">{t('settings.themeLight')}</option>
          </select>
        </div>
      </section>
    </div>
  )
}
