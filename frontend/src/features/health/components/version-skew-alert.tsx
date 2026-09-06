import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { env, isProd } from '@/shared/config/env'
import { Alert, Button } from '@/shared/ui'
import { useHealth } from '../hooks/use-health'
import { isVersionSkewed } from '../lib/version-skew'
import styles from './version-skew-alert.module.scss'

/**
 * server.ts:72-74 serves index.html `no-cache` but /assets/ `immutable`, so a
 * tab that is left open and never navigated keeps running whatever JS it
 * first loaded, however many wire-format changes land underneath it — that is
 * what actually crashed the session this component exists to prevent a repeat
 * of. Reuses useHealth()'s existing 15s poll rather than a timer of its own,
 * so a skewed tab notices within one interval of the next deploy.
 *
 * Reload is a button, never automatic: session-page.tsx keeps the composer's
 * draft in component state, and firing `location.reload()` out from under
 * someone mid-sentence would silently destroy it. The person at the keyboard
 * picks the moment, not this poll.
 *
 * Dismissing the notice is remembered per version pair, not forever: `Alert`
 * only reports that its dismiss button was clicked, it has no notion of
 * "still the same notice", so that has to live here. Keying on
 * `{buildVersion}:{backendVersion}` rather than a bare boolean means a
 * dismissal survives the 15s poll re-fetching the same mismatch, but does
 * not survive the backend moving on to yet another version — which is
 * exactly the moment the notice needs to reappear. Not persisted past this
 * page load: component state, gone on refresh, which is fine because a
 * reload is the one action that clears the condition entirely.
 *
 * Mounted once in providers.tsx, the same way <Toaster /> is — that keeps it
 * visible from every route without threading it through RootLayout's own
 * three-region grid (layout.module.scss), which has no fourth region for it.
 */
export function VersionSkewAlert() {
  const { t } = useTranslation()
  const { data: health } = useHealth()
  const [dismissedPair, setDismissedPair] = useState<string | undefined>(undefined)

  const skewed = isVersionSkewed(env.appVersion, health?.version, isProd)
  if (!skewed) return null

  const pair = `${env.appVersion}:${health?.version}`
  if (pair === dismissedPair) return null

  return (
    <div className={styles.root}>
      <Alert
        tone="warning"
        title={t('health.outdatedTitle')}
        onDismiss={() => setDismissedPair(pair)}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t('health.reload')}
          </Button>
        }
      >
        {t('health.outdatedMessage')}
      </Alert>
    </div>
  )
}
