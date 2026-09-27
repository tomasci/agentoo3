import type { Tone } from '@/shared/components'
import type { Session } from '../hooks/use-sessions'

// A pill's tone for each session status. 'idle'/'queued' get the untoned
// default: nothing to flag yet. Shared by the session page's header badge and
// the sessions table's own Status column, so the two can never drift apart.
export const STATUS_TONE: Record<Session['status'], Tone> = {
  idle: 'neutral',
  queued: 'neutral',
  running: 'accent',
  interrupted: 'warning',
  completed: 'success',
  failed: 'danger',
}
