// The running version.
//
// Read from the package manifest at startup rather than from
// `process.env.npm_package_version`: that variable is only set when a process is
// launched through a package-manager script. The API runs under systemd via
// `bun src/index.ts`, so it was always undefined and the status bar showed the
// hardcoded fallback forever, however many times the version changed.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'

function read(): string {
  // Resolved from this module, not from the working directory, so it holds
  // wherever the process is started from.
  const manifest = join(import.meta.dir, '..', '..', 'package.json')
  try {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    if (typeof version === 'string' && version.length > 0) return version
    logger.warn(`No version in ${manifest}`)
  } catch (error) {
    logger.warn(`Could not read ${manifest}: ${String(error)}`)
  }
  return '0.0.0'
}

export const VERSION = read()
