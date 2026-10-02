// The "What's new" screen's own two system_settings keys (see db/schema.ts's
// systemSettings table) — what the installer records when an install just
// ran, and what the operator recorded closing the screen for. Both wrapped in
// their own schema here so a malformed row (a hand edit, or one written by an
// older version of this app) can be told apart from a valid one the same way
// features/system/settings.ts's own readMaxConcurrentSessionsOverride does
// for its key.
//
// `z` comes from `@hono/zod-openapi`, not bare 'zod' — the same reason
// features/learning/schedule.ts gives for its own identical import: this
// module is reached both through routes.ts (which patches `.openapi()` onto
// z's prototype as a side effect of importing OpenAPIHono first) and through
// src/mark-install.ts, a standalone bun entry point with no OpenAPIHono
// anywhere in its own import graph. Which one happens to run first is not
// this file's to control.
import { z } from '@hono/zod-openapi'

export const LAST_INSTALL_KEY = 'last_install'
export const WHATS_NEW_DISMISSED_KEY = 'whats_new_dismissed'

/** Written by src/mark-install.ts, once per install/update run. */
export const lastInstallSchema = z.object({
  version: z.string().min(1),
  installedAt: z.iso.datetime().openapi({
    description: 'UTC, new Date().toISOString() at the moment the install step ran.',
  }),
})
export type LastInstall = z.infer<typeof lastInstallSchema>

/**
 * Written by POST /whats-new/dismiss. Deliberately just the one field, not a
 * boolean "seen" flag: comparing `installedAt` against the current
 * `last_install.installedAt` (see getWhatsNewState in service.ts) is what
 * lets a *newer* install re-open the screen even though some install has
 * already been dismissed — a plain boolean would have no way to tell "this
 * install was dismissed" from "a later one was".
 */
export const whatsNewDismissedSchema = z.object({
  // { offset: true }: see dismissWhatsNewSchema below for why — this is the
  // same field read back out of the row that schema's own POST just wrote,
  // so accepting here whatever that one accepted on the way in is what keeps
  // an offset-spelled dismissal from failing its own round trip and silently
  // degrading to "absent" the moment readDismissed (service.ts) re-reads it.
  installedAt: z.iso.datetime({ offset: true }),
})
export type WhatsNewDismissed = z.infer<typeof whatsNewDismissedSchema>

export const whatsNewStateSchema = z
  .object({
    installedVersion: z
      .string()
      .nullable()
      .openapi({
        description:
          'Null when no install has ever been recorded (e.g. the docker dev stack, ' +
          'which never runs the installer) — not an error state.',
      }),
    installedAt: z.iso.datetime().nullable().openapi({
      description: 'Null exactly when installedVersion is null.',
    }),
    pending: z.boolean().openapi({
      description:
        'True when the most recent recorded install has not been dismissed yet — ' +
        'installedAt differs from whatever was last dismissed (or nothing has been ' +
        'dismissed at all). Always false when installedVersion is null.',
    }),
  })
  .openapi('WhatsNewState')
export type WhatsNewStateDto = z.infer<typeof whatsNewStateSchema>

// The client sends back the installedAt it actually displayed, not "dismiss
// whatever is current" — so a dismiss that races a newer install (the
// installer runs again, updating last_install, while the screen from the
// previous install is still open in a browser tab) stores the install that
// was actually seen rather than silently swallowing the newer one.
export const dismissWhatsNewSchema = z.object({
  // { offset: true }: the OpenAPI doc advertises `format: date-time`, i.e.
  // RFC 3339, which permits a numeric offset (`+02:00`) alongside `Z` — the
  // bare z.iso.datetime() default rejects every offset, which would reject a
  // value this very route's own documented contract promises to accept.
  // Still stored exactly as sent, never normalized to UTC: see this schema's
  // own file-level comment on why a dismiss's `installedAt` is compared as a
  // string, not a timestamp.
  installedAt: z.iso.datetime({ offset: true }),
})
export type DismissWhatsNewInput = z.infer<typeof dismissWhatsNewSchema>
