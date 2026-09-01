import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit runs outside the app, so read the raw env rather than the
    // parsed config (which would fail on unrelated missing vars).
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/agentoo',
  },
  strict: true,
  verbose: true,
})
