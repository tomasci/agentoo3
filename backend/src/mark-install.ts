// Records "an install/update just happened" for the frontend's "What's new"
// screen — see features/whats-new/service.ts for how that screen reads this
// back and backend/README.md / the root README's install section for when
// this runs.
//
//   bun run mark-install
//
// Invoked by scripts/68-setup-backend.sh right after migrations succeed, as
// the app user, with ONLY DATABASE_URL set in the environment — the same way
// that script already runs `bun run db:migrate`. That is a hard constraint on
// everything this file imports: `@/env` requires REDIS_URL and several other
// vars with no default a bare installer invocation ever sets, and both
// `@/db/client` and the shared `logger` (via `@/env`) pull it in transitively.
// So this file opens its own throwaway Postgres connection straight off
// process.env.DATABASE_URL instead of importing `@/db/client`, and reports
// failure with plain console.error/process.exit rather than the shared
// logger. `@/lib/version` and the feature's own schema.ts are safe to import
// as-is — neither reaches `@/env` (see version.ts's own header for why it no
// longer does).
//
// A failed run must never fail the install: scripts/68-setup-backend.sh
// treats a non-zero exit here as a `log_warn`, not a `die`, so an operator
// never loses a real install over this cosmetic feature. Idempotent by
// construction (upsert on the primary key), so re-running the installer, or
// this script directly, is always safe.

import postgres from 'postgres'
import { LAST_INSTALL_KEY, lastInstallSchema } from '@/features/whats-new/schema'
import { VERSION } from '@/lib/version'

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const value = lastInstallSchema.parse({
    version: VERSION,
    installedAt: new Date().toISOString(),
  })

  // max: 1 — a single upsert, not a pool meant to be reused. connect_timeout
  // keeps an unreachable database from blocking the installer anywhere near
  // as long as the driver's own (much longer) default; lock_timeout bounds
  // how long the upsert can sit waiting behind another writer holding this
  // row's lock (a concurrent installer run, most plausibly) — without it
  // this would wait on that lock forever, same as the query it guards.
  // statement_timeout is set a little above lock_timeout, as a backstop for
  // the query once it does acquire the lock, not a second way to hit the
  // same wait: Postgres reports a blocked lock acquisition as its own
  // "canceling statement due to lock timeout" (55P03) before statement_timeout
  // would ever have a chance to fire for it. Either timeout firing surfaces as
  // a rejected query, caught by main().catch below, so the exit-non-zero/
  // clear-message contract this script's caller relies on (scripts/68-setup-
  // backend.sh's `log_warn`, never fatal) already covers it with no extra
  // handling here.
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 10,
    connection: { lock_timeout: 15_000, statement_timeout: 20_000 },
  })
  try {
    await sql`
      insert into system_settings (key, value, updated_at)
      values (${LAST_INSTALL_KEY}, ${sql.json(value)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
    `
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log(`Recorded install ${value.version} at ${value.installedAt}`)
}

main().catch((error) => {
  console.error(`mark-install failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
