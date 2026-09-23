// Deterministic naming, on purpose: this feature adds no table and no column
// (see the project brief), so the running daemon is the *only* record of a
// scope's docker state — a project's own repo/ checkout, or (once a session
// has its own git worktree) that session's independent copy. Given that, the
// same (slug, sessionId) pair must always produce the same compose project,
// container and image names on every read and every write, or a restart (or a
// second process) could no longer find what an earlier one created.
//
// Repo scope (sessionId: null) must go on producing exactly the strings this
// feature has always produced — every name below predates sessions having
// their own worktrees, and a running container the daemon already knows by
// one of these names must stay findable under it forever.

/**
 * A docker scope: the project's own repo/ checkout (`sessionId: null`), or one
 * session's independent worktree. Every naming function below takes this
 * instead of a bare slug so a forgotten scope is a compile error rather than a
 * silent fall-back to repo names operating on the wrong stack.
 */
export interface DockerScopeRef {
  slug: string
  /** null = the project's repo/ checkout; a session UUID = that session's worktree. */
  sessionId: string | null
}

/**
 * Belt-and-braces, like `lib/paths.ts`'s own `assertInsideProjects`: toSlug()
 * already yields `[a-z0-9-]{1,48}` with no leading or trailing dash, so a
 * project's slug is valid by construction. Asserting it again here is what
 * keeps that true if toSlug() is ever loosened without every caller of this
 * file being re-audited — every name below reaches `docker`'s argv or a
 * `--filter label=` value, and a slug containing `=`, a space or a leading
 * dash would corrupt either.
 *
 * The composite scoped name assembled below is never itself passed to this —
 * it is always built from two independently validated halves (a slug and a
 * session id), so loosening this regex to admit the `_s-<hex>` suffix this
 * file appends is never a temptation with anything to gain from it. That the
 * suffix is joined with `_` and not `-` is deliberate, and load-bearing: `_`
 * is not in this character class, which is exactly what makes `scopedName`
 * below collision-free — see its own comment for the property this protects
 * and docker-names.test.ts for the regression this class of bug once was.
 */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/

function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Refusing to use "${slug}" as a docker resource name: not a valid project slug`)
  }
  return slug
}

/** Same dashed-UUID shape lib/paths.ts's own (unexported) session-id guard
 * checks — kept as an independent regex here rather than imported, so this
 * feature's naming layer has no dependency on that module's internals and
 * cannot be affected by a change to it. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Refusing to use "${sessionId}" as a docker scope id: not a session UUID`)
  }
  return sessionId
}

/**
 * First 12 hex characters of the session id, dashes stripped — 12, not 8: 8
 * hex is only 32 bits, and a few hundred concurrent sessions puts a real
 * collision within reach. That failure mode is silent and destructive (one
 * session's `up` recreating another's containers under a compose project name
 * both happen to share), not merely cosmetic, so the wider margin is worth the
 * extra characters in the name.
 */
function sessionSuffix(sessionId: string): string {
  return assertSessionId(sessionId).replace(/-/g, '').slice(0, 12)
}

/**
 * The short scope discriminator this feature's Redis keys and env vars use —
 * `'repo'` or `'s-<hex12>'` — as opposed to the full names below, which always
 * carry the slug too and reach `docker`'s own argv/labels. Exported so
 * operations.ts and compose-env.ts never have to reinvent this split.
 *
 * The `-` inside `s-<hex12>` is harmless in this form: a Redis key component
 * and an env *value* are never parsed back apart from a slug, so there is
 * nothing adjacent for it to be confused with. That stops being true the
 * moment this string is spliced directly onto a slug to build a
 * compose/container/image name — see `scopedName`'s own comment for why that
 * join uses `_` rather than loosening this format instead.
 */
export function scopeKey(ref: DockerScopeRef): string {
  return ref.sessionId === null ? 'repo' : `s-${sessionSuffix(ref.sessionId)}`
}

/**
 * `_` joins the slug to its scope suffix, never `-`: SLUG_RE (above) forbids
 * `_` in a slug, so no legal slug can ever contain one. That is the whole
 * fix for a real collision this naming scheme used to have: `agentoo-<slug>`
 * and `agentoo-<slug>-s-<hex12>` used to live in one flat, dash-joined string
 * space, so a project whose own slug happened to end in `-s-<12 lowercase
 * hex>` (an ordinary slug toSlug() gladly produces — nothing about it is
 * invalid) composed exactly the same compose-project/container/image name as
 * some *other* project's session scope. Both names have "a slug" and "a
 * dash-joined suffix" shapes indistinguishable from each other once dashes
 * are the only separator in play.
 *
 * With `_` as the join, the first `_` in the composed name is unambiguous:
 * the slug cannot contain one (see SLUG_RE), so no slug can ever *look like*
 * `<other slug>_<scope suffix>` — the string up to the first `_` is provably
 * the real slug, not a forged one. Two composed names can only be equal if
 * they agree on that prefix (hence the same slug) and on everything after it
 * (hence the same scope key, and — barring the accepted 12-hex truncation
 * risk `sessionSuffix` already documents — the same session). See
 * docker-names.test.ts for the exact historical collision this replaces, and
 * a property test that no (slug, sessionId) pair can produce another pair's
 * name.
 */
function scopedName(prefix: string, ref: DockerScopeRef): string {
  const slug = assertSlug(ref.slug)
  const key = scopeKey(ref)
  return key === 'repo' ? `${prefix}-${slug}` : `${prefix}-${slug}_${key}`
}

/** Always passed as `docker compose -p <name>` — see args.ts. */
export function composeProjectName(ref: DockerScopeRef): string {
  return scopedName('agentoo', ref)
}

/** The container name for the plain-Dockerfile path (compose names its own). */
export function containerName(ref: DockerScopeRef): string {
  return scopedName('agentoo', ref)
}

/** The image tag for the plain-Dockerfile path. Same `_` join as
 * `scopedName` above, and for the identical reason — see its comment. */
export function imageReference(ref: DockerScopeRef): string {
  const slug = assertSlug(ref.slug)
  const key = scopeKey(ref)
  return key === 'repo' ? `agentoo/${slug}:latest` : `agentoo/${slug}_${key}:latest`
}

/**
 * Stamped on everything the plain-Dockerfile path creates. Compose services
 * cannot carry these without editing the user's file, which we never do —
 * compose correlation instead relies on the `com.docker.compose.project`
 * label `-p` stamps for us, matched against `composeProjectLabelFilter`.
 *
 * Worktree scope appends a third label, `com.agentoo.session`, carrying the
 * full session id — provenance only. Nothing filters on it: a docker label
 * filter cannot express "label absent", so giving repo scope one too (say,
 * `com.agentoo.scope=repo`) would make every plain-Dockerfile container
 * created before this feature existed vanish from every listing and ownership
 * check that started requiring it.
 */
export function managedLabels(ref: DockerScopeRef): string[] {
  const labels = [`com.agentoo.project=${assertSlug(ref.slug)}`, 'com.agentoo.managed=1']
  return ref.sessionId === null
    ? labels
    : [...labels, `com.agentoo.session=${assertSessionId(ref.sessionId)}`]
}

/** Unscoped, deliberately: a docker label filter cannot express "and no
 * session label at all", so this stays slug-only and matches a container from
 * every scope of this project — callers that need one scope's containers use
 * `composeProjectLabelFilter` (compose) or the `com.agentoo.session` label
 * (see containers.ts's own `listScopeContainers`, for the plain-Dockerfile
 * path). */
export function projectLabelFilter(slug: string): string {
  return `label=com.agentoo.project=${assertSlug(slug)}`
}

export function composeProjectLabelFilter(ref: DockerScopeRef): string {
  return `label=com.docker.compose.project=${composeProjectName(ref)}`
}

// --- the editor feature (per-session code-server) ---------------------------
//
// A separate naming family, deliberately not `scopedName`/`managedLabels`
// above: this feature has its own queue, its own lock and its own container
// lifecycle (see features/editor/), and sharing this module's names/labels
// would make an editor container visible to `listScopeContainers`, the
// session pre-delete gate, and the Docker page's own listing — none of which
// should ever see, count, or tear down a code-server container as if it were
// part of a project's own docker stack.
//
// `agentoo_editor-` (underscore), never `agentoo-editor-` (dash): every name
// `scopedName` produces starts `agentoo-<slug>`, and SLUG_RE forbids `_` in a
// slug (see this file's own header), so no legal (slug, sessionId) pair can
// ever make `scopedName` produce a string starting `agentoo_` — the two
// families are disjoint by construction, not merely by convention. Starting
// this family with `agentoo-editor-` instead would not have that property: a
// project literally named "editor" produces the slug `editor`, and its own
// repo-scope container name is already `agentoo-editor` — a `-` join could
// not tell that project's containers apart from this feature's own.
//
// Session-scoped only: an editor always runs in a session's own worktree
// (see the design's own "Scope" section), so unlike DockerScopeRef there is
// no repo-scope variant and no optional sessionId to guard against forgetting.
export interface EditorScopeRef {
  slug: string
  sessionId: string
}

export function editorContainerName(ref: EditorScopeRef): string {
  const slug = assertSlug(ref.slug)
  const suffix = sessionSuffix(ref.sessionId)
  return `agentoo_editor-${slug}_s-${suffix}`
}

/**
 * Deliberately excludes every `com.agentoo.*`/`com.docker.compose.*` key the
 * plain-Dockerfile/compose paths use (see `managedLabels` above) — an editor
 * container carrying `com.agentoo.project` or `com.agentoo.managed` would
 * make `listScopeContainers` (containers.ts) count it as part of a project's
 * own docker stack, which is exactly the cross-contamination this feature's
 * own label namespace (`com.agentoo.editor*`) exists to prevent.
 *
 * `installId` (container.ts's own `editorInstallId`) is the fourth label,
 * `com.agentoo.editor.install` — not computed here, since deriving it needs
 * `realpath` and `env.PROJECTS_DIR`, and this file stays free of env/fs
 * imports on purpose (see this file's own header). It exists because this
 * box's one docker daemon is shared by more than one agentoo install (a
 * production checkout plus per-worktree dev/test copies): without it, one
 * install's reaper cannot tell its own editor containers apart from a
 * sibling install's, and would remove them the moment its own database does
 * not recognise their session.
 */
export function editorLabels(ref: EditorScopeRef, installId: string): string[] {
  return [
    'com.agentoo.editor=1',
    `com.agentoo.editor.session=${assertSessionId(ref.sessionId)}`,
    `com.agentoo.editor.project=${assertSlug(ref.slug)}`,
    `com.agentoo.editor.install=${installId}`,
  ]
}

/** Every editor container on the box, across every project, session AND
 * install — deliberately unscoped by install: `countRunningEditorContainers`
 * (container.ts) needs exactly this (the cap protects the box's shared RAM,
 * not one install's own share of it — see that function's own comment), and
 * it is the broader half of the AND the reaper narrows with
 * `editorInstallLabelFilter` below. Anything that needs one session's own
 * editor container looks it up by `editorContainerName` instead. */
export const EDITOR_LABEL_FILTER = 'label=com.agentoo.editor=1'

/**
 * The narrower half of the reaper's own AND: ANDed with `EDITOR_LABEL_FILTER`
 * (two separate `docker ps` calls, ids intersected client-side — see
 * container.ts's own `listThisInstallEditorContainerIds`, which is what
 * actually issues them; `docker ps --filter` ANDs multiple `label=` values
 * only within one invocation, and this feature has no reason to touch
 * docker/args.ts's own multi-filter plumbing for a single caller). A
 * container carrying no `com.agentoo.editor.install` label at all — none
 * should ever exist, since this feature stamps every editor it starts — is
 * excluded by construction: docker's own label filter cannot match a label
 * that is not there.
 */
export function editorInstallLabelFilter(installId: string): string {
  return `label=com.agentoo.editor.install=${installId}`
}
