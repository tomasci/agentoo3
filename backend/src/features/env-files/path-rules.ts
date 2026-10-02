// Validation for a store-relative env file path — a client-supplied PUT/DELETE
// target, and the same rule materialize.ts re-runs against whatever is
// actually on disk before it ever touches a session worktree. One function,
// not two copies that could quietly drift apart on what they each allow.
//
// Deliberately narrower than "any relative path": this store exists to solve
// one problem — `.env` files being git-ignored, so a fresh worktree starts
// with none — not to become a general "write any file into every worktree"
// tool. The basename rule below is what keeps it that.

import { hasControlChars } from '@/lib/text'

export type PathCheck = { ok: true } | { ok: false; reason: string }

const MAX_LENGTH = 255

// Every path segment (directories and the basename alike) is confined to this
// charset. Leading dots are allowed — `.devcontainer/.env` is a real shape —
// so the only way a segment becomes dangerous is `.` / `..` itself (checked
// separately below, since both are valid matches of this charset) or one of
// the two names carved out next.
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/

// `.env`, `.env.<suffix>` (`.env.local`, `.env.development`, ...) or
// `<name>.env` (`db.env`). Rules out `package.json`, `secrets.txt` and any
// other file a project might otherwise be tempted to stash here.
const DOTENV_BASENAME_RE = /^(?:\.env(?:\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.env)$/

/**
 * Validate one store-relative env file path.
 *
 * POSIX-relative, confined to a `.env`-shaped basename, with `.git` and
 * `node_modules` refused as directory segments — the first because this
 * store sits next to a project's `repo/` checkout and must never be mistaken
 * for part of one, the second because it is never a legitimate place for a
 * project's own env files to live.
 */
export function checkEnvFilePath(path: string): PathCheck {
  if (path.length === 0) return { ok: false, reason: 'Path is empty' }
  if (path.length > MAX_LENGTH) {
    return { ok: false, reason: `Path is longer than ${MAX_LENGTH} characters` }
  }
  if (path.startsWith('/')) return { ok: false, reason: 'Path may not start with "/"' }
  if (path.endsWith('/')) return { ok: false, reason: 'Path may not end with "/"' }
  if (path.includes('\\')) return { ok: false, reason: 'Path may not contain "\\"' }
  // hasControlChars already covers NUL (0x00 <= 0x1f) — called out by name in
  // the reason anyway, since "control character" reads as a puzzle to the
  // human who hit this.
  if (hasControlChars(path)) {
    return { ok: false, reason: 'Path may not contain a NUL byte or other control characters' }
  }

  const segments = path.split('/')
  if (segments.some((s) => s.length === 0)) {
    return { ok: false, reason: 'Path may not contain an empty segment (e.g. "a//b")' }
  }
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'Path may not contain a "." or ".." segment' }
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, reason: 'Path may not contain a ".git" segment' }
  }
  if (segments.some((s) => s === 'node_modules')) {
    return { ok: false, reason: 'Path may not contain a "node_modules" segment' }
  }
  if (segments.some((s) => !SEGMENT_RE.test(s))) {
    return {
      ok: false,
      reason: 'Path segments may only contain letters, digits, "_", "-" and "."',
    }
  }

  const basename = segments[segments.length - 1] as string
  if (!DOTENV_BASENAME_RE.test(basename)) {
    return {
      ok: false,
      reason:
        'Filename must be ".env", ".env.<suffix>" or "<name>.env" ' +
        '(e.g. ".env.local", ".env.development", "db.env")',
    }
  }

  return { ok: true }
}
