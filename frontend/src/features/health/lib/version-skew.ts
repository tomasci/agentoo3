import { z } from 'zod'

// `major.minor.build` (version.json → vite.config.ts's `__APP_VERSION__`,
// e.g. "0.1.79"), turned into three comparable integers. `useHealth` does not
// validate its own response (getApiHealthSchema.ts exists but nothing runs
// it), so a backend's `version` is untrusted input here the same way an SSE
// frame is in streamed-message.ts — parsed, not cast. Anything that is not
// exactly three dot-separated integers — a future format, a backend that
// hasn't added the field yet, `undefined` while the poll is still in
// flight — comes back `undefined` rather than throwing, which is what makes
// "cannot compare" and "compares equal" the same silent outcome below.
const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .transform((value) => value.split('.').map(Number) as [number, number, number])

function parseVersion(value: string | undefined): [number, number, number] | undefined {
  if (!value) return undefined
  const result = versionSchema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Whether this tab's own bundle is *behind* the backend it is polling — the
 * one direction in which reloading is the correct thing for a person to do,
 * and the direction the incident this exists to prevent a repeat of actually
 * failed in (see version-skew-alert.tsx for the why).
 *
 * Compares numerically, one part at a time, not as strings and not as a bare
 * `!==`: during a deploy the frontend's static assets can land before the
 * backend restarts, so the tab is briefly *ahead* of the server it is
 * talking to. That direction must stay silent — it clears itself within one
 * poll of the backend catching up, and there is no message that would be
 * true to show in the meantime, let alone one reloading could act on.
 *
 * Gated on `isProd`: a dev tree sitting between commits legitimately
 * disagrees with a backend restarted on a newer one, constantly and for no
 * reason a person needs to act on — a warning that is wrong most of the time
 * in dev trains everyone to ignore it before it ever matters in prod.
 *
 * Equal versions, a `backendVersion` of `undefined` (useHealth()'s poll
 * hasn't answered yet, or is down), and a version on either side that does
 * not parse as `major.minor.build` all read as "no skew" — there is nothing,
 * or nothing trustworthy, to compare against.
 */
export function isVersionSkewed(
  buildVersion: string,
  backendVersion: string | undefined,
  isProd: boolean,
): boolean {
  if (!isProd) return false
  const build = parseVersion(buildVersion)
  const backend = parseVersion(backendVersion)
  if (!build || !backend) return false
  const [buildMajor, buildMinor, buildBuild] = build
  const [backendMajor, backendMinor, backendBuild] = backend
  // Destructured rather than indexed in a loop: under
  // `noUncheckedIndexedAccess` a tuple read by a variable index types as
  // possibly `undefined`, even though the length is fixed at 3.
  if (buildMajor !== backendMajor) return buildMajor < backendMajor
  if (buildMinor !== backendMinor) return buildMinor < backendMinor
  return buildBuild < backendBuild
}
