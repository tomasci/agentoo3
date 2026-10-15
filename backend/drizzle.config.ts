import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit runs outside the app, so read the raw env rather than the
    // parsed config (which would fail on unrelated missing vars).
    //
    // The fallback only exists so `db:generate`, which never connects, works
    // without a database. It used to be localhost:5432/agentoo — on an
    // installed box, exactly where the live database is — and sessions run
    // without DATABASE_URL (lib/child-env.ts), so a `db:migrate` or `db:push`
    // an agent ran without setting one would have aimed there. A `.invalid`
    // host never resolves (RFC 2606): those now fail, naming the problem.
    url: process.env.DATABASE_URL ?? 'postgresql://database-url-not-set.invalid/agentoo',
  },
  strict: true,
  verbose: true,
})
