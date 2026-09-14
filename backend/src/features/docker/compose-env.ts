// The env vars this feature hands to every `docker compose` invocation it
// makes — never templated into the project's own `.env` (that file is the
// user's, and their escape hatch; compose reads it from the project directory
// automatically, which for a worktree scope already is the worktree). A
// compose file referencing `AGENTOO_*` today resolves them to empty, so these
// are injected at *both* scopes: injecting only at worktree scope would make
// the same file behave differently depending on which scope ran it.

import type { DockerScopeRef } from './names'
import { composeProjectName } from './names'

/**
 * Deterministic, unsigned 32-bit FNV-1a. Not a cryptographic hash and never
 * used as one — just a cheap, stable way to spread compose project names
 * across a port range with no allocator and no shared state to coordinate.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Range 20000-31990 (base) / 20000-31999 (base + 0..9): above every
 * privileged port and below Linux's default ephemeral range (32768+), so
 * nothing this feature hands out here can collide with a port the kernel
 * might hand a client socket a moment later.
 */
const PORT_RANGE_BASE = 20000
const PORT_RANGE_BUCKETS = 1200
const PORT_RANGE_STEP = 10
const PORT_COUNT = 10

/**
 * The env vars available to a compose file this feature runs, for both the
 * read path (`getComposeConfig`, so a displayed access URL matches what `up`
 * will actually bind) and the write path (the worker's own `compose up`).
 *
 * `AGENTOO_PORT_0`..`AGENTOO_PORT_9` are ten whole, pre-computed values rather
 * than one offset, because compose's own `${...}` substitution has no
 * arithmetic — there is nowhere for a compose file to add an offset to a base
 * even if this handed one out. Derivation is a pure function of the scope: no
 * allocator, no on-disk state, so the same scope gets the same ports across a
 * process restart with nothing to reconcile.
 */
export function composeEnvFor(ref: DockerScopeRef): Record<string, string> {
  const composeProject = composeProjectName(ref)
  const portBase =
    PORT_RANGE_BASE + (fnv1a32(composeProject) % PORT_RANGE_BUCKETS) * PORT_RANGE_STEP

  const env: Record<string, string> = {
    AGENTOO_PROJECT_SLUG: ref.slug,
    AGENTOO_SCOPE: ref.sessionId === null ? 'repo' : 'worktree',
    AGENTOO_COMPOSE_PROJECT: composeProject,
  }
  // Omitted entirely at repo scope, not set to an empty string: a compose file
  // that writes `${AGENTOO_SESSION_ID:?}` is asking to fail loudly if it is
  // ever run outside a session's own worktree, and an empty-but-present var
  // would satisfy that check instead of tripping it.
  if (ref.sessionId !== null) env.AGENTOO_SESSION_ID = ref.sessionId
  for (let i = 0; i < PORT_COUNT; i++) env[`AGENTOO_PORT_${i}`] = String(portBase + i)
  return env
}
