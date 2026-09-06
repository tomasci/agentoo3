import { z } from 'zod'
import { logger } from '@/shared/lib/logger'
import type { SessionMessage } from '../hooks/use-sessions'

/**
 * The one message a stream frame ever carries, validated on arrival.
 *
 * Deliberately NOT the generated `getApiSessionsIdMessagesStatus200Schema`'s
 * per-message shape (getApiSessionsIdMessagesSchema.ts): the backend's three
 * publish sites now all emit the same mapped DTO, but a rolling deploy runs
 * an old instance and a new one side by side for the length of the rollout,
 * and only the new code publishes that DTO — an old instance still mid-deploy
 * is still on the raw Drizzle row, which has no `files` key at all (`files`
 * is a joined array the DTO mapper computes, not a column on `messages`).
 * Both shapes are genuinely on the wire at once during that window: a live
 * capture caught 95 frames, 77 with no `files` key and 18 with one, from the
 * two instances answering the same stream (see
 * tests/streamed-message-real-frames.test.ts's provenance note for the
 * capture itself). Validating against the strict DTO schema would reject
 * every raw-row frame from the old instance and freeze the live transcript
 * the moment one arrived, which is exactly backwards for a check that exists
 * to catch a *malformed* frame, not a *pre-rollout* one. So this schema
 * requires only what actually matters:
 *   - `seq` a finite integer. This is the field the incident turned on: an
 *     arrival with no `seq` (or a non-numeric one) made `newestCachedSeq`
 *     (message-cache.ts) return `NaN` via `Math.max(max, message.seq)`, and
 *     the backend's `/events?after=` treats a non-finite `after` as `-1` —
 *     replaying the *entire* transcript on every single reconnect from then
 *     on, rather than just the messages missed.
 *   - the scalars `transcript.ts` actually reads off a message (`id`, `type`,
 *     `title`, `parentToolUseId`, `pending`, `payload`, `createdAt`).
 *   - `files`, left optional rather than required, for the raw-row case above
 *     — `transcript.ts` already reads it as `message.files ?? []`.
 * Unknown keys are ignored rather than rejected (zod's default `strip`
 * mode for `z.object()`), so a field a newer instance adds does not start
 * failing this against an older one still finishing its rollout.
 */
export const streamedMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.int(),
  type: z.string(),
  parentToolUseId: z.string().nullable(),
  title: z.string().nullable(),
  pending: z.boolean(),
  payload: z.unknown().nullish(),
  files: z.array(z.unknown()).optional(),
  createdAt: z.string(),
})

/**
 * Parses one raw SSE `message` frame into the `SessionMessage` it carries, or
 * `undefined` for anything that fails: a frame that is not JSON, or whose
 * `message` does not match the shape above. Every rejection is logged, not
 * silent — the previous behaviour here (`JSON.parse` cast straight to
 * `SessionMessage`, a truthy check as the only guard) is what let a seq-less
 * arrival through to poison the reconnect cursor with `NaN` in the first
 * place.
 *
 * Dropped rather than thrown: unlike a REST response (`useSessionMessages`,
 * use-sessions.ts), nothing is awaiting this frame the way a query awaits a
 * response, so there is no `isError` for a throw here to usefully set —
 * dropping the one bad arrival and carrying on with what the transcript
 * already has *is* the recovery.
 */
export function parseStreamedMessage(data: string): SessionMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    logger.warn('Dropping an SSE frame that was not valid JSON', error)
    return undefined
  }
  const candidate = (parsed as { message?: unknown } | null)?.message
  const result = streamedMessageSchema.safeParse(candidate)
  if (!result.success) {
    logger.warn('Dropping a malformed SSE message', result.error.issues)
    return undefined
  }
  // `files` is optional above for the raw-row wire shape, but `SessionMessage`
  // (the generated DTO type) declares it required — `transcript.ts` is the
  // one place that reads it, and already treats it as possibly absent
  // (`message.files ?? []`), so trusting the validated shape here is no
  // looser than what the reader already does with it.
  return result.data as unknown as SessionMessage
}
