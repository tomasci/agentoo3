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
