// Resolving a folder name to an adoptable directory.
//
// Adoption used to take an arbitrary absolute path guarded by a denylist of
// system roots. It now takes a *name* within SOURCES_DIR, which turns the check
// into an allowlist: a path that does not resolve inside that directory is
// refused, so there is no list of dangerous places to keep up to date and no way
// to point a project at /etc by construction.

import { realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { env } from '@/env'
import { hasControlChars } from './text'

export interface AdoptPathResult {
  ok: boolean
  reason?: string
  resolved?: string
}

/** A folder name, not a path: separators and traversal are rejected outright. */
export function checkSourceName(name: string): { ok: boolean; reason?: string } {
  if (name.length === 0) return { ok: false, reason: 'Folder name is empty' }
  if (name.length > 255) return { ok: false, reason: 'Folder name is too long' }
  if (hasControlChars(name)) return { ok: false, reason: 'Folder name contains control characters' }
  if (name === '.' || name === '..') return { ok: false, reason: 'Invalid folder name' }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, reason: 'Give a folder name, not a path' }
  }
  return { ok: true }
}

export async function resolveSource(name: string): Promise<AdoptPathResult> {
  const nameCheck = checkSourceName(name)
  if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason }

  const root = resolve(env.SOURCES_DIR)
  const candidate = join(root, name)

  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch {
    return { ok: false, reason: `${name} is not in ${env.SOURCES_DIR}` }
  }

  // Resolved after following symlinks: a link inside the directory pointing out
  // of it must not smuggle an arbitrary target past the check.
  const target = resolve(resolved)
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, reason: `${name} resolves outside ${env.SOURCES_DIR}` }
  }

  try {
    if (!(await stat(target)).isDirectory()) {
      return { ok: false, reason: `${name} is not a directory` }
    }
  } catch {
    return { ok: false, reason: `${name} is not readable` }
  }

  return { ok: true, resolved: target }
}
