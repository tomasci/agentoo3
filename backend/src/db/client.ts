import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/env'
import * as schema from './schema'

// One pool per process. The worker and the API each get their own.
const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} })

export const db = drizzle(sql, { schema })
export { sql }
export type Database = typeof db
