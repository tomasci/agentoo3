// The running version.
//
// Read from the package manifest at startup rather than from
// `process.env.npm_package_version`: that variable is only set when a process is
// launched through a package-manager script. The API runs under systemd via
// `bun src/index.ts`, so it was always undefined and the status bar showed the
// hardcoded fallback forever, however many times the version changed.
//
// console.warn here, not the shared `logger`: logger.ts imports `@/env`, and
// src/mark-install.ts (the installer's "an install just happened" marker,
// invoked with only DATABASE_URL set — see that file's own header) imports
// this module for the same VERSION a running API reports. Pulling `@/env` in
// transitively would make that script fail on every other required var
// (REDIS_URL, ...) before it ever touched the database. This failure path
// (an unreadable or malformed package.json) is rare enough on either caller
// that losing the shared logger's formatting here costs nothing real.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(): string {
  // Resolved from this module, not from the working directory, so it holds
  // wherever the process is started from.
  const manifest = join(import.meta.dir, '..', '..', 'package.json')
  try {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    if (typeof version === 'string' && version.length > 0) return version
    console.warn(`No version in ${manifest}`)
  } catch (error) {
    console.warn(`Could not read ${manifest}: ${String(error)}`)
  }
  return '0.0.0'
}

export const VERSION = read()
