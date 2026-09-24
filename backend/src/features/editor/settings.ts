// Seeds code-server's VS Code user settings.json before every start, so
// every editor on this install opens with the same installation-wide
// defaults (no welcome page, no built-in AI chat, no secondary sidebar) —
// see backend/README.md's "Editor" section and config/editor-settings.json,
// the shipped file this reads by default. lifecycle.ts calls this directly,
// after container.ts's own `prepareEditorRuntimeDir` and before `docker run`.
//
// Not a leaf like container.ts: reading and JSON-validating a defaults file
// (shipped, or an operator's EDITOR_SETTINGS_FILE override) is unrelated to
// container.ts's own "docker mechanics" scope (see that file's own header),
// so it lives here instead. It does not import `@/env` either — the caller
// (lifecycle.ts) already reads EDITOR_SETTINGS_FILE and passes it in, which
// keeps every path here a plain, directly testable function argument rather
// than something a test has to mock a shared module to vary.

import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { logger } from '@/lib/logger'

/** repo-root/config/editor-settings.json — resolved from this module's own
 * location, never `process.cwd()` (matching lib/version.ts's own reasoning
 * for the package manifest): the worker can be started from any working
 * directory and must still find the same file. Four `..`: this file sits at
 * backend/src/features/editor/, and the repo root is four levels up. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const SHIPPED_SETTINGS_PATH = join(REPO_ROOT, 'config', 'editor-settings.json')

export interface EditorSettingsSeedResult {
  /** Whether settings.json was actually (re)written into the runtime dir. */
  applied: boolean
  /** For the start log and the warning below: a path relative to the repo
   * root for the shipped file, or the absolute override path verbatim — see
   * the design's own "start-log narration". */
  label: string
  /** Set only when `applied` is false — why the defaults were not used. */
  reason?: string
}

type DefaultsResult =
  | { ok: true; settings: Record<string, unknown>; label: string }
  | { ok: false; label: string; reason: string }

/**
 * Read + JSON-validate the defaults file without touching anything else on
 * disk. Never throws: a typo in an operator's file, or a missing/corrupt
 * shipped one, is this function's own ordinary, expected outcome — every
 * caller decides for itself that it is never fatal to an editor start.
 */
async function readDefaults(overridePath: string | undefined): Promise<DefaultsResult> {
  const path = overridePath ?? SHIPPED_SETTINGS_PATH
  const label = overridePath ?? relative(REPO_ROOT, SHIPPED_SETTINGS_PATH)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, label, reason: String(error) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, label, reason: `invalid JSON (${message})` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed
    return { ok: false, label, reason: `must be a JSON object, not ${kind}` }
  }

  return { ok: true, settings: parsed as Record<string, unknown>, label }
}

/**
 * Seed `${runtimeDir}/data/User/settings.json` with the installation's
 * default VS Code settings, overwriting whatever a previous session in this
 * SAME runtime dir left behind — the design's own "reset on start": a user's
 * in-editor changes last only until that editor stops.
 *
 * `${runtimeDir}/data` (mounted into the container at
 * `/run/agentoo-editor/data`, code-server's own `--user-data-dir`) is
 * created and chmod'd unconditionally, whether or not the defaults file
 * itself turns out to be usable — code-server needs somewhere to write its
 * own user-data-dir state regardless, and a bad settings file must not leave
 * that directory missing. Only the settings.json write is conditional.
 *
 * Directory/file ownership mirrors container.ts's own
 * `prepareEditorRuntimeDir`: 0700 dirs, 0600 file, chowned to the worktree
 * owner only when this process is root (an ordinary service account cannot
 * chown to a uid it is not, and by this point `assertWorktreeOwnerIsRunnable`
 * has already required this process to BE that owner instead).
 */
export async function seedEditorSettings(
  runtimeDir: string,
  owner: { uid: number; gid: number },
  overridePath: string | undefined,
): Promise<EditorSettingsSeedResult> {
  const dataDir = join(runtimeDir, 'data')
  const userDir = join(dataDir, 'User')
  const settingsPath = join(userDir, 'settings.json')

  await mkdir(userDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  await chmod(userDir, 0o700)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0
  if (myUid === 0) {
    await chown(dataDir, owner.uid, owner.gid)
    await chown(userDir, owner.uid, owner.gid)
  }

  const defaults = await readDefaults(overridePath)
  if (!defaults.ok) {
    const message = `Editor default settings (${defaults.label}) not applied: ${defaults.reason}`
    // A missing/broken shipped file is a bug in what this repo shipped, not
    // a bad deployment — called out as one, while still not blocking the
    // start any differently than an operator's own bad override would.
    logger.warn(
      overridePath
        ? message
        : `${message} (packaging bug: the shipped file should always be valid)`,
    )
    return { applied: false, label: defaults.label, reason: defaults.reason }
  }

  const json = `${JSON.stringify(defaults.settings, null, 2)}\n`
  await writeFile(settingsPath, json, 'utf8')
  // `writeFile`'s own `mode` option only applies when the file is CREATED —
  // an existing settings.json from a previous start keeps its old
  // permission bits otherwise, so this is what actually guarantees 0600 on
  // every seed, not just the first one, mirroring `prepareEditorRuntimeDir`'s
  // identical reasoning for `chmod` after `mkdir`.
  await chmod(settingsPath, 0o600)
  if (myUid === 0) {
    await chown(settingsPath, owner.uid, owner.gid)
  }

  return { applied: true, label: defaults.label }
}
