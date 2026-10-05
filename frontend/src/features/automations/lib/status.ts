import type { Tone } from '@/shared/components'
import type { Automation, AutomationRun } from '../hooks/use-automations'

/** Tone for the Active/Paused badge on the list and detail pages. */
export const AUTOMATION_TONE = (automation: Automation): Tone =>
  automation.paused ? 'neutral' : 'success'

/** Tone for a run's own status pill. 'dispatching' reads as in-progress,
 *  'dispatched' as the hand-off succeeding (the session itself carries its
 *  own status from here — see `SESSION_STATUS_TONE` below), 'failed' as an
 *  error. */
export const RUN_STATUS_TONE: Record<AutomationRun['status'], Tone> = {
  dispatching: 'accent',
  dispatched: 'success',
  failed: 'danger',
}

/** Mirrors features/sessions/lib/status.ts's own `STATUS_TONE` — duplicated
 *  rather than imported across the feature boundary, the same choice that
 *  file's sibling `lib/format.ts`s make throughout this app (see
 *  features/library/lib/format.ts's own comment on why). A run's linked
 *  session only ever carries the subset of statuses a session can be *while
 *  still linked to a run row* (every `Session['status']` value, in fact —
 *  the backend's own `automationRunSessionStatusEnum` is the full session
 *  status enum), so this covers the same six keys. */
export const SESSION_STATUS_TONE: Record<NonNullable<AutomationRun['session']>['status'], Tone> = {
  idle: 'neutral',
  queued: 'neutral',
  running: 'accent',
  interrupted: 'warning',
  completed: 'success',
  failed: 'danger',
}
