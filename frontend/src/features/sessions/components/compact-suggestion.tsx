import { FoldVerticalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { CompactSessionButton } from './compact-session-button'

/**
 * The banner shown once a session has cost more than
 * `COMPACT_SUGGEST_COST_USD` (lib/compaction.ts — the caller owns that gate):
 * every further message carries the whole history, so this is the moment a
 * summary and a fresh session start paying for themselves. Its button is the
 * header's own control, driven by the same hook state, not a second path into
 * the backend.
 *
 * `role="status"` rather than `Alert`'s default `alert`: this is a standing
 * suggestion, not something that should interrupt a screen reader mid-read.
 */
export function CompactSuggestion({
  totalCostUsd,
  busy,
  inFlight,
  onCompact,
}: {
  totalCostUsd: number
  busy: boolean
  inFlight: boolean
  onCompact: () => void
}) {
  const { t } = useTranslation()
  return (
    <Alert role="status" className="shrink-0 border-primary/50">
      <FoldVerticalIcon />
      <AlertTitle>{t('sessions.compact.bannerTitle')}</AlertTitle>
      <AlertDescription>
        {t('sessions.compact.bannerBody', { cost: `$${totalCostUsd.toFixed(2)}` })}
      </AlertDescription>
      <div className="col-start-2 mt-2">
        <CompactSessionButton
          variant="default"
          label={t('sessions.compact.bannerAction')}
          busy={busy}
          inFlight={inFlight}
          onClick={onCompact}
        />
      </div>
    </Alert>
  )
}
