import type { Tone } from '@/shared/ui'
import type { Idea, IdeaStatus } from '../hooks/use-ideas'

/**
 * The six columns, in board order — left to right, exactly as a card moves
 * through them. The single source for that order: a column list, a status
 * picker, anything that needs "all six statuses" reads this array rather than
 * repeating the literals.
 */
export const IDEA_STATUSES = [
  'backlog',
  'todo',
  'selected_for_development',
  'in_progress_dev',
  'verification',
  'done',
] as const satisfies readonly IdeaStatus[]

/**
 * `Record<IdeaStatus, string>`, not a template string built from the status at
 * the call site: if the backend's six-member enum ever grows, this fails the
 * build until the new member is given a key, instead of a new column silently
 * rendering untranslated.
 */
export const IDEA_STATUS_I18N_KEY: Record<IdeaStatus, string> = {
  backlog: 'ideas.status.backlog',
  todo: 'ideas.status.todo',
  selected_for_development: 'ideas.status.selected_for_development',
  in_progress_dev: 'ideas.status.in_progress_dev',
  verification: 'ideas.status.verification',
  done: 'ideas.status.done',
}

/**
 * Same `Record<IdeaStatus, Tone>` idiom `project-status.tsx` uses for
 * projects: `styles[status]` string indexing types as `string | undefined`
 * under `noUncheckedIndexedAccess` and silently drops the colour for a status
 * this file does not know about, where a `Record` fails to compile instead.
 *
 * `backlog`/`todo` are `neutral` — nothing is happening yet. `selected_for_
 * development`/`in_progress_dev` are `accent` — the machine (prompt
 * generation, then a session turn) is doing the work. `verification` is
 * `warning`, the one column that genuinely needs a person's judgement, the
 * same reasoning `projects.status.needs_manual` gets `warning` for. `done` is
 * `success`. `danger` is deliberately unused here: a stuck handoff is
 * reported through the card's own `lastError`, not by recolouring a column.
 */
export const IDEA_STATUS_TONE: Record<IdeaStatus, Tone> = {
  backlog: 'neutral',
  todo: 'neutral',
  selected_for_development: 'accent',
  in_progress_dev: 'accent',
  verification: 'warning',
  done: 'success',
}

/**
 * Whether an idea has work in flight that nothing but a poll will ever learn
 * about — there is no project-level push channel here, only a per-session one
 * (`features/sessions/hooks/use-session-stream.ts`), and a session is not even
 * created until handoff. Drives `useIdeas`'/`useIdea`'s own `refetchInterval`
 * below (see `hooks/use-ideas.ts`), so every branch here is something the
 * board's own list DTO already carries — never a reason to fetch anything
 * extra just to answer this question.
 *
 * - `latestPrompt.status === 'pending'`: the one-shot generation call
 *   (features/ideas/prompt-service.ts on the backend) hasn't produced
 *   `ready`/`failed` yet.
 * - `openRun !== null`: idea_runs' own "no endedAt yet" row exists — a
 *   handoff is somewhere between generating and running.
 * - `sessionStatus` is `'queued'` or `'running'`: the bound session itself is
 *   mid-turn. Belt and braces alongside `openRun` rather than redundant with
 *   it: the run row is opened and closed by a track this one hands off to,
 *   and this is what keeps the board honest even in a moment that bookkeeping
 *   has not caught up with the session's own state.
 */
export function isIdeaBusy(idea: Idea): boolean {
  if (idea.latestPrompt?.status === 'pending') return true
  if (idea.openRun !== null) return true
  if (idea.sessionStatus === 'queued' || idea.sessionStatus === 'running') return true
  return false
}
