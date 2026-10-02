// A client-side mirror of the backend's rule
// (backend/src/features/env-files/path-rules.ts's `checkEnvFilePath`), kept
// in lock step with it rule-for-rule so the "Add" form can reject an obvious
// mistake before a round trip. This is instant feedback only, never the
// boundary itself: every PUT/DELETE re-runs the real check server-side, and
// its 400 is what actually enforces it (and is still surfaced verbatim via
// `apiErrorMessage` — see the add form — for whatever this mirror misses).
//
// Reasons come back as i18n keys (`envFiles.validation.*` in both locales),
// not text, the same way `sshKeyFormSchema`
// (features/ssh-keys/model/ssh-key-form.schema.ts) hands its caller a key to
// pass through `t()` rather than a hardcoded English string.

export type PathCheck = { ok: true } | { ok: false; messageKey: string }

const MAX_LENGTH = 255

// Mirrors path-rules.ts's SEGMENT_RE: every segment confined to this charset,
// leading dots allowed (`.devcontainer/.env` is real).
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/

// Mirrors path-rules.ts's DOTENV_BASENAME_RE: `.env`, `.env.<suffix>` or
// `<name>.env`.
const DOTENV_BASENAME_RE = /^(?:\.env(?:\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.env)$/

// Mirrors the backend's hasControlChars (backend/src/lib/text.ts) exactly,
// including C1 (0x80-0x9F) — a charCodeAt loop rather than a
// `/[\u0000-\u001f]/`-shaped regex, which biome's
// noControlCharactersInRegex rule refuses outright.
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export function checkEnvFilePath(path: string): PathCheck {
  if (path.length === 0) return { ok: false, messageKey: 'envFiles.validation.empty' }
  if (path.length > MAX_LENGTH) return { ok: false, messageKey: 'envFiles.validation.tooLong' }
  if (path.startsWith('/')) return { ok: false, messageKey: 'envFiles.validation.leadingSlash' }
  if (path.endsWith('/')) return { ok: false, messageKey: 'envFiles.validation.trailingSlash' }
  if (path.includes('\\')) return { ok: false, messageKey: 'envFiles.validation.backslash' }
  if (hasControlChars(path)) {
    return { ok: false, messageKey: 'envFiles.validation.controlChars' }
  }

  const segments = path.split('/')
  if (segments.some((s) => s.length === 0)) {
    return { ok: false, messageKey: 'envFiles.validation.emptySegment' }
  }
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, messageKey: 'envFiles.validation.dotSegment' }
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, messageKey: 'envFiles.validation.gitSegment' }
  }
  if (segments.some((s) => s === 'node_modules')) {
    return { ok: false, messageKey: 'envFiles.validation.nodeModulesSegment' }
  }
  if (segments.some((s) => !SEGMENT_RE.test(s))) {
    return { ok: false, messageKey: 'envFiles.validation.invalidChars' }
  }

  const basename = segments[segments.length - 1] as string
  if (!DOTENV_BASENAME_RE.test(basename)) {
    return { ok: false, messageKey: 'envFiles.validation.badBasename' }
  }

  return { ok: true }
}
