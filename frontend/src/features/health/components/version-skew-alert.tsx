import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { env, isProd } from '@/shared/config/env'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { useHealth } from '../hooks/use-health'
import { isVersionSkewed } from '../lib/version-skew'

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
 * Dismissing the notice is remembered per version pair, not forever: it is
 * plain component state next to a plain `onClick`, so "still the same
 * notice" has to live here rather than in `Alert` itself. Keying on
 * `{buildVersion}:{backendVersion}` rather than a bare boolean means a
 * dismissal survives the 15s poll re-fetching the same mismatch, but does
 * not survive the backend moving on to yet another version — which is
 * exactly the moment the notice needs to reappear. Not persisted past this
 * page load: component state, gone on refresh, which is fine because a
 * reload is the one action that clears the condition entirely.
 *
 * Mounted once in providers.tsx, the same way the toasters are — that keeps
 * it visible from every route without threading it through RootLayout's own
 * grid, which has no region set aside for it. `role="status"`/`aria-live`
 * are set explicitly rather than left to `Alert`'s own `role="alert"`
 * default: a stale build is not an emergency and must not talk over a screen
 * reader the way an assertive live region would.
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
    <div className="fixed top-[calc(env(safe-area-inset-top)+0.75rem)] left-1/2 z-50 w-full max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2">
      <Alert role="status" aria-live="polite">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>{t('health.outdatedTitle')}</AlertTitle>
        <AlertDescription>{t('health.outdatedMessage')}</AlertDescription>
        <AlertAction className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t('health.reload')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.dismiss')}
            onClick={() => setDismissedPair(pair)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  )
}
