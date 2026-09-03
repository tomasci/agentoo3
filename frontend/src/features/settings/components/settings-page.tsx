import { useAtom } from 'jotai'
import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { themeAtom } from '@/shared/store/ui'
import { Card, Field, PageHeader, Select, type SelectOption, Stack } from '@/shared/ui'
import styles from './settings-page.module.scss'

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ru: 'Русский' }

// `Select`'s public props stop at `name`/`ref` — no `id` (see forms/select.tsx).
// The real, focusable/queryable element it renders is the hidden native
// `<select>` the `ref` prop already exposes, so that's where these land.
function idRef(id: string): Ref<HTMLSelectElement> {
  return (el) => {
    if (el) el.id = id
  }
}

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

  const languageOptions: SelectOption[] = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: LANGUAGE_NAMES[language] ?? language.toUpperCase(),
  }))

  const themeOptions: SelectOption[] = [
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') },
  ]

  return (
    <div className={styles.page}>
      <PageHeader title={t('settings.heading')} description={t('settings.lead')} />

      <Card>
        <Stack gap={5}>
          <Field label={t('settings.language')} hint={t('settings.languageHint')}>
            <Select
              ref={idRef('settings-language')}
              options={languageOptions}
              value={i18n.resolvedLanguage}
              onValueChange={(value) => value && void i18n.changeLanguage(value)}
            />
          </Field>

          {/* A select rather than the old icon toggle: a two-state button never
              says which state it is in, only which way it will flip. */}
          <Field label={t('settings.theme')} hint={t('settings.themeHint')}>
            <Select
              ref={idRef('settings-theme')}
              options={themeOptions}
              value={theme}
              onValueChange={(value) => setTheme(value === 'light' ? 'light' : 'dark')}
            />
          </Field>
        </Stack>
      </Card>
    </div>
  )
}
