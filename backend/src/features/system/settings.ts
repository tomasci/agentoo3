// The admin-configurable surface backing `/system/settings` — today exactly
// one key, max_concurrent_sessions, read by both this API process and the
// worker (queue/session-concurrency.ts polls getMaxConcurrentSessions on a
// short interval so a save here takes effect without a worker restart).
//
// "No row for a key" means "use the built-in default" rather than an invalid
// state — the identical absent-means-default model prompts.ts already uses
// for a saved prompt file: resetting deletes the row instead of writing the
// default value back into it, so the default stays one thing (env.ts's own
// WORKER_CONCURRENCY) rather than a copy of it that could drift.

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { systemSettings } from '@/db/schema'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import {
  maxConcurrentSessionsSchema,
  type SystemSettingsDto,
  type UpdateSystemSettingsInput,
} from './schema'

const MAX_CONCURRENT_SESSIONS_KEY = 'max_concurrent_sessions'

/**
 * The stored max_concurrent_sessions override, or undefined if no row exists
 * or the row that does exist fails to validate against the same schema the
 * write path enforces — a hand-edited value, or one written by an older
 * version of this app that accepted a shape this one no longer does. Treated
 * exactly like "no row" rather than thrown, mirroring prompts.ts's
 * readSavedPrompt: a malformed saved value is "nothing usable", not a reason
 * to 500 the whole settings page.
 */
async function readMaxConcurrentSessionsOverride(): Promise<number | undefined> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, MAX_CONCURRENT_SESSIONS_KEY))
    .limit(1)
  if (!row) return undefined

  const parsed = maxConcurrentSessionsSchema.safeParse(row.value)
  if (!parsed.success) {
    logger.warn(
      `Stored ${MAX_CONCURRENT_SESSIONS_KEY} (${JSON.stringify(row.value)}) does not match the ` +
        'expected shape — treating it as unset',
    )
    return undefined
  }
  return parsed.data
}

/**
 * The effective cap on simultaneous session turns right now: a saved
 * override if one exists, else env.WORKER_CONCURRENCY. Reads the database
 * fresh on every call rather than caching it — see this module's own header
 * for why the worker needs that.
 */
export async function getMaxConcurrentSessions(): Promise<number> {
  return (await readMaxConcurrentSessionsOverride()) ?? env.WORKER_CONCURRENCY
}

export async function getSystemSettings(): Promise<SystemSettingsDto> {
  const override = await readMaxConcurrentSessionsOverride()
  return {
    maxConcurrentSessions: {
      value: override ?? env.WORKER_CONCURRENCY,
      source: override === undefined ? 'default' : 'override',
      defaultValue: env.WORKER_CONCURRENCY,
    },
  }
}

/**
 * Applies a sparse patch: a number upserts the row (bumping updatedAt even
 * when the value matches the current default — deliberate, see
 * systemSettingsSourceSchema's own description of why that still counts as
 * `source: 'override'`, not `'default'`); `null` deletes the row, reverting
 * to the default; the key left out of the body entirely is untouched.
 * Checked with `in` rather than `!== undefined` so this still reads
 * correctly if a future second key is added here, following the identical
 * rule, rather than relying on JSON's inability to carry a literal
 * `undefined` on the wire for just this one.
 *
 * Always returns a freshly re-read getSystemSettings() rather than the
 * value just written, so a write that races this one is never papered over
 * by an in-memory echo of what this call alone thinks is now true.
 */
export async function updateSystemSettings(
  body: UpdateSystemSettingsInput,
): Promise<SystemSettingsDto> {
  if ('maxConcurrentSessions' in body) {
    const value = body.maxConcurrentSessions
    if (value === null) {
      await db.delete(systemSettings).where(eq(systemSettings.key, MAX_CONCURRENT_SESSIONS_KEY))
    } else if (value !== undefined) {
      await db
        .insert(systemSettings)
        .values({ key: MAX_CONCURRENT_SESSIONS_KEY, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt: new Date() },
        })
    }
  }
  return getSystemSettings()
}
