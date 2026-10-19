import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

/**
 * The one "compact this session" control, rendered twice — in the header, and
 * as the action of the cost banner — so both disable for the same reasons and
 * say so in the same words.
 *
 * Disabled while the session is mid-turn (the backend answers a compaction
 * with 409 then, so the button never offers one) or a compaction of it is
 * already in flight. A disabled button never reaches hover or focus, and so
 * never opens a tooltip, which is the whole point of saying *why*: the tooltip
 * trigger is a focusable `span` around it instead (the same shape
 * `features/system`'s usage page uses), and it is there whether or not the
 * button is disabled, so the button is never remounted — and keyboard focus
 * never lost — by the click that disables it.
 */
export function CompactSessionButton({
  label,
  hint,
  busy,
  inFlight,
  onClick,
  variant = 'outline',
}: {
  label: string
  /** What the button does, shown on hover/focus while it can be clicked. */
  hint?: string
  /** The session is queued or running a turn. */
  busy: boolean
  inFlight: boolean
  onClick: () => void
  variant?: 'default' | 'outline'
}) {
  const { t } = useTranslation()
  const blockedBecause = inFlight
    ? t('sessions.compact.inProgressTooltip')
    : busy
      ? t('sessions.compact.busyTooltip')
      : undefined
  const disabled = blockedBecause !== undefined
  const tooltip = blockedBecause ?? hint

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={disabled ? 0 : undefined}
            className="inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={onClick}>
          {inFlight && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {inFlight ? t('sessions.compact.inProgress') : label}
        </Button>
      </TooltipTrigger>
      {tooltip && <TooltipContent>{tooltip}</TooltipContent>}
    </Tooltip>
  )
}
