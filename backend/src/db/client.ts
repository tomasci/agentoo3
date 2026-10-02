import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/env'
import * as schema from './schema'

// Constructed on first use, not at import.
//
// postgres.js parses the connection string in its constructor, so building the
// client at module scope meant anything that merely imported a route — such as
// rendering the OpenAPI document — needed a real, parseable DATABASE_URL and
// crashed without one. The proxy keeps `db.select(...)` reading normally at every
// call site while deferring construction until a query actually happens.

let instance: ReturnType<typeof createClient> | undefined

function createClient() {
  // One pool per process; the API and the worker each get their own.
  const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} })
  return { sql, db: drizzle(sql, { schema }) }
}

function client() {
  if (!instance) instance = createClient()
  return instance
}

export type Database = ReturnType<typeof createClient>['db']

export const db = new Proxy({} as Database, {
  get: (_target, property, receiver) => Reflect.get(client().db, property, receiver),
}) as Database

/** The underlying postgres.js handle, for shutdown. */
export const closeDb = async (): Promise<void> => {
  if (instance) await instance.sql.end({ timeout: 5 })
  instance = undefined
}

/**
 * Runs `fn` while holding a Postgres session-level advisory lock keyed on
 * `key`, on a connection reserved just for that lock. Not a transaction
 * wrapping `fn`: `fn` is free to use `db` normally — its own transactions,
 * its own connections borrowed from the same pool this reserves from —
 * without this lock's own connection becoming a bottleneck for queries that
 * have nothing to do with `key`. The lock lives in Postgres itself, not this
 * process, which is the point: two different processes (an API server and a
 * worker, say) serialising on the same key is exactly what a caller like
 * features/learning/suggestions.ts's per-target apply lock needs, and an
 * in-process mutex (a `Map`, a module-level promise chain) could never give
 * that.
 *
 * `hashtextextended` turns `key` into the bigint `pg_advisory_lock` wants —
 * Postgres's own stable text hash, so nothing outside this function needs to
 * agree on how to pack a string into two int4 halves by hand.
 *
 * Unlocking is attempted even if `fn` threw, and the reserved connection is
 * released even if unlocking itself failed (the connection dropping out from
 * under us, most likely) — `pg_advisory_unlock` of a lock this session does
 * not hold is a harmless false, not an error, so there is no harm in asking.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const reserved = await client().sql.reserve()
  try {
    await reserved`select pg_advisory_lock(hashtextextended(${key}, 0))`
    return await fn()
  } finally {
    try {
      await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`
    } finally {
      reserved.release()
    }
  }
}
