// Canary values for every variable lib/child-env.ts has to keep away from the
// processes this app hands its environment to — for tests that need "the
// worker's process.env carries all of them" to be literally true.
//
// The names are spelled out here rather than imported from
// APP_CREDENTIAL_VARS: they are the ones the fix is *required* to remove, so
// an edit that drops one from that list fails a test instead of quietly
// shrinking what the tests check. Every value is unmistakable in a dump and
// points at a `.invalid` host (RFC 2606: never resolves), so even a leak
// these tests exist to catch cannot reach a real server.

export const REQUIRED_SCRUBBED = [
  'DATABASE_URL',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSSLMODE',
  'PGOPTIONS',
] as const

const CANARY_HOST = 'leak-canary.invalid'

/** One canary per required name. DATABASE_URL and REDIS_URL are real URLs,
 * since a child that boots `@/env` needs them to parse. */
export const CANARY_CREDENTIALS: Record<string, string> = {
  ...Object.fromEntries(REQUIRED_SCRUBBED.map((key) => [key, `leak-canary-${key}`])),
  DATABASE_URL: `postgres://canary:leak-canary-password@${CANARY_HOST}:5432/leak_canary`,
  REDIS_URL: `redis://:leak-canary-password@${CANARY_HOST}:6379/0`,
  POSTGRES_HOST: CANARY_HOST,
  REDIS_HOST: CANARY_HOST,
  PGHOST: CANARY_HOST,
}

/** The two variables a session's CLI process authenticates with — the ones
 * the scrub must *not* touch. */
export const CLAUDE_CREDENTIALS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'canary-oauth-token-must-survive',
  ANTHROPIC_API_KEY: 'canary-api-key-must-survive',
}

/** True when any canary value shows up anywhere in `env`, under any name —
 * the check that catches a credential smuggled through under a key nobody
 * thought to look for. */
export function leakedCanaries(env: Record<string, string | undefined>): string[] {
  const values = new Set(Object.values(CANARY_CREDENTIALS))
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && values.has(value))
    .map(([key]) => key)
}

/**
 * Run `body` with every canary — and both Claude credentials — set in this
 * process's own `process.env`, then put back exactly what was there before:
 * setup-env.ts's DATABASE_URL/REDIS_URL placeholders, or nothing.
 */
export async function withCanaryEnv<T>(body: () => Promise<T>): Promise<T> {
  const injected = { ...CANARY_CREDENTIALS, ...CLAUDE_CREDENTIALS }
  const previous = new Map(Object.keys(injected).map((key) => [key, process.env[key]]))
  Object.assign(process.env, injected)
  try {
    return await body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
