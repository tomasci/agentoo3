// The environment this app hands to processes it does not control.
//
// The worker and the API both run with this app's own database and Redis
// credentials in `process.env` — systemd loads them from the install's .env,
// and env.ts parses them from there. Anything that copies `process.env` into a
// child copies those along with it, and several children run code an agent or
// a user's project wrote: a session's CLI process and every Bash command its
// agent runs, a `docker compose` interpolating a project's compose file, a git
// hook in a project's repository. That is not a theoretical leak. A security
// audit session's subagent ran a PoC that imported `@/db/client` and deleted
// every project; it had exported a scratch DATABASE_URL in an earlier Bash
// call, env does not survive between calls, and the run that mattered fell
// back to the one it inherited from the worker — the live database.
//
// So every such child gets `withoutAppCredentials(process.env)` instead of
// `process.env`: a copy with these keys removed and everything else kept.
// Removed rather than replaced with a placeholder, so a script that needs a
// database has to be handed one on purpose, and one that forgot fails at
// env parsing instead of quietly finding production.

/**
 * The variables that reach this app's own Postgres and Redis.
 *
 * DATABASE_URL and REDIS_URL are what env.ts reads; POSTGRES_* and REDIS_*
 * are the parts the installer writes next to them (scripts/60-install-postgres.sh,
 * scripts/62-install-redis.sh). The PG* block is every connection variable
 * libpq reads — psql, pg_dump, drizzle-kit and any driver built on libpq fall
 * back to them when a connection string leaves a field out — plus
 * PGUSERNAME, which postgres.js (this app's own driver) reads as well.
 * PGSYSCONFDIR is here because it decides where a `service=` name is looked
 * up. REDISCLI_AUTH is redis-cli's equivalent of PGPASSWORD.
 *
 * Not here, deliberately: CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY. A
 * session's CLI process authenticates with them, so they have to reach it.
 */
export const APP_CREDENTIAL_VARS = [
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
  'REDISCLI_AUTH',
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGUSERNAME',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGREQUIREAUTH',
  'PGCHANNELBINDING',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSYSCONFDIR',
  'PGOPTIONS',
  'PGAPPNAME',
  'PGSSLMODE',
  'PGREQUIRESSL',
  'PGSSLNEGOTIATION',
  'PGSSLCOMPRESSION',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLCERTMODE',
  'PGSSLROOTCERT',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLSNI',
  'PGREQUIREPEER',
  'PGSSLMINPROTOCOLVERSION',
  'PGSSLMAXPROTOCOLVERSION',
  'PGMINPROTOCOLVERSION',
  'PGMAXPROTOCOLVERSION',
  'PGGSSENCMODE',
  'PGKRBSRVNAME',
  'PGGSSLIB',
  'PGGSSDELEGATION',
  'PGCONNECT_TIMEOUT',
  'PGCLIENTENCODING',
  'PGTARGETSESSIONATTRS',
  'PGLOADBALANCEHOSTS',
] as const

/**
 * A copy of `source` with every `APP_CREDENTIAL_VARS` key removed. `source`
 * itself is never modified, and keys whose value is `undefined` are dropped,
 * so the result is a plain `Record<string, string>` that any spawn API takes
 * as is.
 *
 * `delete` on the copy, not `{ ...source, DATABASE_URL: undefined }`: see
 * `withoutInheritedAgentooKeys` in features/sessions/runner-options.ts —
 * `Options.env` is typed `Record<string, string>`, and an explicit
 * `undefined` only works there because node:child_process happens to drop
 * it. An absent key needs no such luck.
 *
 * Callers that add their own variables spread them in *after* this, so a
 * value they set on purpose — a test's own placeholder DATABASE_URL, say —
 * still reaches the child.
 */
export function withoutAppCredentials(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of APP_CREDENTIAL_VARS) delete env[key]
  return env
}
