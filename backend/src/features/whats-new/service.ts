// The "What's new" screen's state: whether an install the operator has not
// yet closed the screen for exists, system-wide — not per-browser, and not
// tracking which individual changelog entries were seen (the changelog
// content itself is frontend-owned JSON, bundled rather than served from
// here). See schema.ts's header for the two system_settings keys this reads
// and writes.
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { systemSettings } from '@/db/schema'
import { logger } from '@/lib/logger'
import {
  type DismissWhatsNewInput,
  LAST_INSTALL_KEY,
  type LastInstall,
  lastInstallSchema,
  WHATS_NEW_DISMISSED_KEY,
  type WhatsNewDismissed,
  type WhatsNewStateDto,
  whatsNewDismissedSchema,
} from './schema'

/**
 * Reads one system_settings row and validates it against `schema`, treating
 * both "no row" and "a row that fails to validate" as undefined — mirrors
 * features/system/settings.ts's own readMaxConcurrentSessionsOverride: a
 * hand-edited or stale value degrades the feature (the screen simply does
 * not show), it never 500s the request that asked.
 */
async function readSetting<T>(
  key: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Promise<T | undefined> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1)
  if (!row) return undefined

  const parsed = schema.safeParse(row.value)
  if (!parsed.success) {
    logger.warn(
      `Stored ${key} (${JSON.stringify(row.value)}) does not match the expected shape — ` +
        'treating it as unset',
    )
    return undefined
  }
  return parsed.data
}

const readLastInstall = (): Promise<LastInstall | undefined> =>
  readSetting(LAST_INSTALL_KEY, lastInstallSchema)

const readDismissed = (): Promise<WhatsNewDismissed | undefined> =>
  readSetting(WHATS_NEW_DISMISSED_KEY, whatsNewDismissedSchema)

/**
 * Current state of the screen. No `last_install` row at all — a box whose
 * installer never ran, e.g. the docker dev stack (docker/README.md: its
 * `init` service applies migrations directly and never runs mark-install) —
 * reports `pending: false` with both other fields null, not an error: there
 * is nothing to announce.
 */
export async function getWhatsNewState(): Promise<WhatsNewStateDto> {
  const install = await readLastInstall()
  if (!install) return { installedVersion: null, installedAt: null, pending: false }

  const dismissed = await readDismissed()
  return {
    installedVersion: install.version,
    installedAt: install.installedAt,
    pending: dismissed?.installedAt !== install.installedAt,
  }
}

/**
 * Records that the operator closed the screen for the install whose
 * `installedAt` they were actually shown. Stored as-is — never clamped to
 * the current `last_install` — so a dismiss that lost a race against a
 * newer install (the installer ran again while the screen was still open
 * somewhere) cannot make that newer install's own `pending` state read as
 * already dismissed.
 *
 * Returns a freshly re-read getWhatsNewState() rather than an echo of the
 * input, the same reason updateSystemSettings (features/system/settings.ts)
 * gives for its own return value: a write that races this one is never
 * papered over by an in-memory guess at what is now true.
 */
export async function dismissWhatsNew(body: DismissWhatsNewInput): Promise<WhatsNewStateDto> {
  await db
    .insert(systemSettings)
    .values({ key: WHATS_NEW_DISMISSED_KEY, value: body, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: body, updatedAt: new Date() },
    })
  return getWhatsNewState()
}
