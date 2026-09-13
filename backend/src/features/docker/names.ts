// Deterministic naming, on purpose: this feature adds no table and no column
// (see the project brief), so the running daemon is the *only* record of a
// project's docker state. Given that, the same slug must always produce the
// same compose project, container and image names on every read and every
// write, or a restart (or a second process) could no longer find what an
// earlier one created.

/**
 * Belt-and-braces, like `lib/paths.ts`'s own `assertInsideProjects`: toSlug()
 * already yields `[a-z0-9-]{1,48}` with no leading or trailing dash, so a
 * project's slug is valid by construction. Asserting it again here is what
 * keeps that true if toSlug() is ever loosened without every caller of this
 * file being re-audited — every name below reaches `docker`'s argv or a
 * `--filter label=` value, and a slug containing `=`, a space or a leading
 * dash would corrupt either.
 */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/

function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Refusing to use "${slug}" as a docker resource name: not a valid project slug`)
  }
  return slug
}

/** Always passed as `docker compose -p <name>` — see args.ts. */
export function composeProjectName(slug: string): string {
  return `agentoo-${assertSlug(slug)}`
}

/** The container name for the plain-Dockerfile path (compose names its own). */
export function containerName(slug: string): string {
  return `agentoo-${assertSlug(slug)}`
}

/** The image tag for the plain-Dockerfile path. */
export function imageReference(slug: string): string {
  return `agentoo/${assertSlug(slug)}:latest`
}

/**
 * Stamped on everything the plain-Dockerfile path creates. Compose services
 * cannot carry these without editing the user's file, which we never do —
 * compose correlation instead relies on the `com.docker.compose.project`
 * label `-p` stamps for us, matched against `composeProjectLabelFilter`.
 */
export function managedLabels(slug: string): string[] {
  return [`com.agentoo.project=${assertSlug(slug)}`, 'com.agentoo.managed=1']
}

export function projectLabelFilter(slug: string): string {
  return `label=com.agentoo.project=${assertSlug(slug)}`
}

export function composeProjectLabelFilter(slug: string): string {
  return `label=com.docker.compose.project=${composeProjectName(slug)}`
}
