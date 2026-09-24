import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/shared/components'
import { SUPPORTED_LANGUAGES } from '@/shared/i18n'
import { themeAtom } from '@/shared/store/ui'
import { Card, CardContent } from '@/shared/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/shared/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ru: 'Русский' }

interface Option {
  value: string
  label: string
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

  const languageOptions: Option[] = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: LANGUAGE_NAMES[language] ?? language.toUpperCase(),
  }))

  const themeOptions: Option[] = [
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') },
  ]

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <PageHeader title={t('settings.heading')} description={t('settings.lead')} />

      <Card>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-language">{t('settings.language')}</FieldLabel>
              <Select
                items={languageOptions}
                value={i18n.resolvedLanguage}
                onValueChange={(value) => value && void i18n.changeLanguage(value)}
              >
                <SelectTrigger id="settings-language" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t('settings.languageHint')}</FieldDescription>
            </Field>

            {/* A select rather than the old icon toggle: a two-state button never
                says which state it is in, only which way it will flip. */}
            <Field>
              <FieldLabel htmlFor="settings-theme">{t('settings.theme')}</FieldLabel>
              <Select
                items={themeOptions}
                value={theme}
                onValueChange={(value) => setTheme(value === 'light' ? 'light' : 'dark')}
              >
                <SelectTrigger id="settings-theme" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {themeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t('settings.themeHint')}</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}
