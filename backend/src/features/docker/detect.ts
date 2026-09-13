// Pure filesystem detection — no docker CLI involved. This is deliberately
// cheap: GET /docker/detection runs it for every project behind a short TTL
// cache (see service.ts), and it must never shell out to answer "does this
// project even have a compose file".

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Precedence order compose itself uses when no `-f` is given. */
export const COMPOSE_BASENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const

export const DOCKERFILE_BASENAME = 'Dockerfile'

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Override basenames matching the *family* of a detected base file.
 *
 * Passing `-f` explicitly (which this feature always does — see the brief on
 * why relying on compose's own defaults is unsafe once any `-f` is given at
 * all) disables compose's automatic override discovery. So a bare `docker
 * compose up` a human runs by hand and the run this feature drives would
 * silently diverge unless the override is looked for and passed too — and the
 * override has to come from the same `compose.*` vs `docker-compose.*` family
 * as the base file compose actually picked, or a `docker-compose.yml` project
 * would incorrectly pick up an unrelated `compose.override.yaml`.
 */
function overrideBasenamesFor(base: string): string[] {
  return base.startsWith('docker-compose')
    ? ['docker-compose.override.yaml', 'docker-compose.override.yml']
    : ['compose.override.yaml', 'compose.override.yml']
}

export interface Detection {
  hasCompose: boolean
  hasDockerfile: boolean
  /** Basename only, e.g. "compose.yaml" — never a path back to the caller. */
  composeFile: string | null
  composeOverrideFile: string | null
  dockerfile: string | null
}

export async function detectProjectDocker(projectPath: string): Promise<Detection> {
  let composeFile: string | null = null
  for (const name of COMPOSE_BASENAMES) {
    if (await isFile(join(projectPath, name))) {
      composeFile = name
      break
    }
  }

  let composeOverrideFile: string | null = null
  if (composeFile) {
    for (const name of overrideBasenamesFor(composeFile)) {
      if (await isFile(join(projectPath, name))) {
        composeOverrideFile = name
        break
      }
    }
  }

  const dockerfile = (await isFile(join(projectPath, DOCKERFILE_BASENAME)))
    ? DOCKERFILE_BASENAME
    : null

  return {
    hasCompose: composeFile !== null,
    hasDockerfile: dockerfile !== null,
    composeFile,
    composeOverrideFile,
    dockerfile,
  }
}
