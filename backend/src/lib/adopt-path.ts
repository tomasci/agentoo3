// Validation for a directory the operator asks us to adopt as a project.
//
// The path is deliberately arbitrary — pointing at a folder that already exists
// on the server is the feature, so this is not an allowlist. What it refuses is
// the small set of targets that could only be a mistake or an attack, because a
// session on an adopted directory hands Claude full tool access to it.

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { hasControlChars } from './text'

// Adopting any of these, or anything inside them, would wreck the host.
const FORBIDDEN_ROOTS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib',
  '/var/log',
]

export interface AdoptPathResult {
  ok: boolean
  reason?: string
  resolved?: string
}

export async function checkAdoptPath(input: string): Promise<AdoptPathResult> {
  if (!isAbsolute(input)) {
    return { ok: false, reason: 'Path must be absolute' }
  }
  if (hasControlChars(input)) {
    return { ok: false, reason: 'Path contains control characters' }
  }
  if (input.split(sep).includes('..')) {
    return { ok: false, reason: 'Path may not contain ".."' }
  }

  // Resolve symlinks before judging it: a link is how an allowed-looking path
  // becomes a forbidden one.
  let resolved: string
  try {
    resolved = await realpath(input)
  } catch {
    return { ok: false, reason: `${input} does not exist` }
  }

  try {
    if (!(await stat(resolved)).isDirectory()) {
      return { ok: false, reason: `${input} is not a directory` }
    }
  } catch {
    return { ok: false, reason: `${input} is not readable` }
  }

  const target = resolve(resolved)
  if (target === sep) {
    return { ok: false, reason: 'Refusing to adopt the filesystem root' }
  }
  for (const root of FORBIDDEN_ROOTS) {
    if (target === root || target.startsWith(root + sep)) {
      return { ok: false, reason: `Refusing to adopt a path under ${root}` }
    }
  }

  return { ok: true, resolved: target }
}
