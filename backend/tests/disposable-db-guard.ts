// The check every DB child (tests/*-db-child.ts and the few other children
// that connect to Postgres) awaits before its first query: is DATABASE_URL a
// throwaway cluster from pg-cluster.ts, or something real?
//
// A child takes DATABASE_URL from its environment, because its parent test
// spawns it pointed at a temp cluster. Run directly instead (`bun
// tests/x-db-child.ts`), by a person or an agent, it inherits whatever
// DATABASE_URL the shell has, which on an installed box is the live database.
// Several children reset their fixtures with unscoped deletes
// (notifications-verify-db-child.ts deletes every project), so that would be
// the same wipe the bulk-delete guard migration exists for.
//
// The marker is a database-level setting, agentoo.disposable_test_db, which
// startTempCluster puts on its databases with ALTER DATABASE after migrating:
// - 'on' on the main database. Migration 0015's bulk-delete guard triggers
//   step aside there, so the suite's resets can wipe tables.
// - 'guarded' on the guarded database, when a test asks for one
//   (bulk-delete-guard.test.ts). Just as disposable, but the triggers only
//   honour 'on', so they stay live, as in production.
// This accepts either. It reads the marker from pg_db_role_setting, as the
// triggers do, never current_setting(): a connection can set the GUC for
// itself (SET, or a startup parameter such as `?agentoo.disposable_test_db=on`
// in the URL), but only ALTER DATABASE, which Postgres allows only a
// superuser for this parameter, can put it on the database.
//
// Call it as the first statement of the child, as `await
// assertDisposableTestDb()`, before any mock.module or dynamic import. Do not
// rely on importing this module for a top-level-await side effect instead:
// ESM does not hold sibling imports back while one module awaits. Children
// that import app modules statically are still safe, because no app module
// queries at import time (db/client.ts builds its pool on the first query).

import postgres from 'postgres'

/** The GUC startTempCluster sets on its databases with ALTER DATABASE. */
export const DISPOSABLE_DB_SETTING = 'agentoo.disposable_test_db'

/** Disposable, and migration 0015's bulk-delete guard triggers step aside. The
 * triggers recognise this value, at the database level, and nothing else. */
export const DISPOSABLE_VALUE = 'on'

/** Disposable, but the guard triggers stay live (pg-cluster.ts's guarded
 * database). */
export const DISPOSABLE_GUARDED_VALUE = 'guarded'

/** The guard's own exit status (EX_CONFIG), so a parent can tell a refusal
 * apart from a child that ran and failed. */
export const REFUSAL_EXIT_CODE = 78

export const REFUSAL_MESSAGE = 'refusing to run: DATABASE_URL is not a disposable test cluster'

/** host:port/db, for the message. Never the credentials. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

async function refuse(reason: string): Promise<never> {
  const message =
    `${REFUSAL_MESSAGE} (${reason}).\n` +
    'DB children are meant to be spawned by their *.test.ts against a cluster from ' +
    `tests/pg-cluster.ts, which marks its databases with ${DISPOSABLE_DB_SETTING} = ` +
    `'${DISPOSABLE_VALUE}' (or '${DISPOSABLE_GUARDED_VALUE}'). ` +
    'Run the parent test (bun test tests/<name>.test.ts) instead.\n'
  // Wait for the write: exiting straight after one can drop it on a pipe.
  await new Promise<void>((resolve) => process.stderr.write(message, () => resolve()))
  process.exit(REFUSAL_EXIT_CODE)
}

/** Exits the process unless `url`'s database carries the disposable marker,
 * with either value. */
export async function assertDisposableTestDb(
  url: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  if (!url) return refuse('DATABASE_URL is not set')

  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} })
  let marked: boolean
  try {
    const [row] = await sql<{ marked: boolean }[]>`
      select exists (
        select 1
        from pg_db_role_setting s
        join pg_database d on d.oid = s.setdatabase
        where d.datname = current_database()
          and s.setrole = 0
          and s.setconfig && ${[
            `${DISPOSABLE_DB_SETTING}=${DISPOSABLE_VALUE}`,
            `${DISPOSABLE_DB_SETTING}=${DISPOSABLE_GUARDED_VALUE}`,
          ]}::text[]
      ) as marked`
    marked = row?.marked === true
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {})
    const detail = error instanceof Error ? error.message : String(error)
    return refuse(`could not check ${describeUrl(url)}: ${detail}`)
  }
  await sql.end({ timeout: 5 })

  if (!marked) {
    return refuse(
      `${describeUrl(url)} has no database-level ${DISPOSABLE_DB_SETTING} = ` +
        `'${DISPOSABLE_VALUE}' or '${DISPOSABLE_GUARDED_VALUE}'`,
    )
  }
}
