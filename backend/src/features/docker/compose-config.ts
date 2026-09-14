// `docker compose config --format json`, and its two siblings: `ls` (for
// foreign-stack detection) and `version`.
//
// Parsing compose's own resolved config is the one CLI call this feature
// treats as load-bearing rather than best-effort: it is what resolves the
// `ports` short syntax, `.env` interpolation, `extends`, `include`, profiles
// and multi-file merges *exactly the way `up` will* — a hand-rolled YAML
// parser would own a second, worse compose semantics, and a displayed access
// URL could disagree with the actual binding. See detect.ts's own comment for
// why `-f`/`-p` are always explicit rather than relying on compose's
// defaults.

import { z } from 'zod'
import { logger } from '@/lib/logger'
import {
  type ComposeFiles,
  composeConfigArgs,
  composeConfigServicesArgs,
  composeLsArgs,
  composeVersionArgs,
} from './args'
import { DOCKER_READ_TIMEOUT_MS, type DockerCli, realDockerCli } from './cli'

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** ≤2000 chars — the same cap `daemon.error` and every other stderr-derived
 * field in this feature uses, so one long compose YAML error cannot dwarf the
 * response it rides along in. */
function truncatedError(text: string): string {
  return text.slice(0, 2000)
}

// --- docker compose config --format json ------------------------------------

const composePortRaw = z
  .object({
    target: z.union([z.number(), z.string()]).optional(),
    published: z.union([z.number(), z.string()]).optional(),
    host_ip: z.string().optional(),
    protocol: z.string().optional(),
  })
  .passthrough()

// `depends_on` is a map under the long form and an array under the short
// form (`depends_on: [a, b]`) — both are legal compose syntax and both show
// up in `config`'s resolved output depending on how the source file wrote it.
const composeDependsOnRaw = z.union([z.record(z.string(), z.unknown()), z.array(z.string())])

const composeServiceRaw = z
  .object({
    image: z.string().optional(),
    // An object (build context/args) under the long form, a bare string
    // (the context path) under the short form — both mean "this service
    // builds", which is all this feature reads it for.
    build: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    profiles: z.array(z.string()).optional(),
    depends_on: composeDependsOnRaw.optional(),
    ports: z.array(composePortRaw).optional(),
  })
  .passthrough()

const composeConfigRaw = z
  .object({ services: z.record(z.string(), composeServiceRaw).optional() })
  .passthrough()

export interface DeclaredPort {
  containerPort: number
  publishedPort: number | null
  publishedRange: string | null
  protocol: 'tcp' | 'udp'
  hostIp: string | null
}

function toDeclaredPort(raw: z.infer<typeof composePortRaw>): DeclaredPort | undefined {
  const containerPort = Number(raw.target)
  if (!Number.isInteger(containerPort)) return undefined

  const protocol = raw.protocol === 'udp' ? 'udp' : 'tcp'
  const hostIp = raw.host_ip ?? null
  const publishedText = raw.published === undefined ? '' : String(raw.published)
  const isRange = publishedText.includes('-')

  return {
    containerPort,
    publishedPort: !isRange && /^\d+$/.test(publishedText) ? Number(publishedText) : null,
    publishedRange: isRange ? publishedText : null,
    protocol,
    hostIp,
  }
}

export interface ComposeServiceConfig {
  name: string
  image: string | null
  build: boolean
  profiles: string[]
  dependsOn: string[]
  declaredPorts: DeclaredPort[]
}

function dependsOnNames(raw: z.infer<typeof composeDependsOnRaw> | undefined): string[] {
  if (!raw) return []
  return Array.isArray(raw) ? raw : Object.keys(raw)
}

function toServiceConfig(
  name: string,
  raw: z.infer<typeof composeServiceRaw>,
): ComposeServiceConfig {
  return {
    name,
    image: raw.image ?? null,
    build: raw.build !== undefined,
    profiles: raw.profiles ?? [],
    dependsOn: dependsOnNames(raw.depends_on),
    declaredPorts: (raw.ports ?? [])
      .map(toDeclaredPort)
      .filter((p): p is DeclaredPort => p !== undefined),
  }
}

export interface ComposeConfigResult {
  ok: boolean
  /** Populated only when `ok` is false — trimmed stderr, ≤2000 chars. */
  configError: string | null
  services: ComposeServiceConfig[]
}

export async function getComposeConfig(
  composeProjectName: string,
  files: ComposeFiles,
  run: { cwd: string; env: Record<string, string> },
  cli: DockerCli = realDockerCli,
): Promise<ComposeConfigResult> {
  const result = await cli.run(composeConfigArgs(composeProjectName, files), {
    cwd: run.cwd,
    env: run.env,
    timeoutMs: DOCKER_READ_TIMEOUT_MS,
  })

  if (result.ok) {
    const shaped = composeConfigRaw.safeParse(safeJsonParse(result.stdout))
    if (shaped.success) {
      const services = Object.entries(shaped.data.services ?? {}).map(([name, service]) =>
        toServiceConfig(name, service),
      )
      return { ok: true, configError: null, services }
    }
    logger.warn(
      `docker compose config --format json returned an unexpected shape: ${shaped.error.message}`,
    )
  }

  // Degrade to names-only: either the compose file is genuinely broken (a
  // legitimate project state — see GET /projects/{id}/docker's own contract,
  // which must still answer 200 with containers populated from `docker ps`),
  // or this Compose is too old for `config --format json`. Either way, ports
  // for these services come from running containers downstream, never from a
  // hand-rolled YAML parse.
  const names = await cli.run(composeConfigServicesArgs(composeProjectName, files), {
    cwd: run.cwd,
    env: run.env,
    timeoutMs: DOCKER_READ_TIMEOUT_MS,
  })
  const services = names.ok
    ? names.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          image: null,
          build: false,
          profiles: [],
          dependsOn: [],
          declaredPorts: [],
        }))
    : []

  return {
    ok: false,
    configError: truncatedError(result.stderr || 'docker compose config failed'),
    services,
  }
}

// --- docker compose version ---------------------------------------------------

const composeVersionRaw = z.object({ version: z.string().optional() }).passthrough()

export async function getComposeVersion(cli: DockerCli = realDockerCli): Promise<string | null> {
  const result = await cli.run(composeVersionArgs(), { timeoutMs: DOCKER_READ_TIMEOUT_MS })
  if (!result.ok) return null

  const shaped = composeVersionRaw.safeParse(safeJsonParse(result.stdout))
  if (shaped.success && shaped.data.version) return shaped.data.version

  // Older Compose prints a plain "Docker Compose version v2.24.0" line even
  // when asked for --format json; scavenge a version-looking token from it
  // rather than reporting nothing.
  return result.stdout.match(/v?\d+\.\d+\.\d+\S*/)?.[0] ?? null
}

// --- docker compose ls --format json (foreign-stack detection) --------------

const composeLsEntryRaw = z
  .object({
    Name: z.string().optional(),
    Status: z.string().optional(),
    // A comma-separated string, not an array — verified against the CLI's
    // documented `--format json` output for `ls`.
    ConfigFiles: z.string().optional(),
  })
  .passthrough()

export interface ForeignStack {
  name: string
  status: string
  configFiles: string[]
}

/**
 * Stacks compose already knows about that use *our* compose file but are not
 * *our* stack — compose's default project name is the compose file's
 * directory basename, so a human who ran a bare `docker compose up` made a
 * stack this feature must detect and never adopt. At repo scope that basename
 * is `repo` for every project on this box (see lib/paths.ts's `projectRepo`);
 * at worktree scope it is the session's own uuid (`projectWorktree`'s leaf
 * directory), so the foreign name to watch for differs by scope even though
 * this function's own signature does not need to change to know it — both
 * `composeProjectName` and `composeFileAbsPath` already carry the scope by
 * the time they reach here.
 *
 * Best-effort by contract: any failure here — a parse error, `ls` itself
 * failing — logs a warning and returns `[]`. GET /projects/{id}/docker must
 * never fail because this secondary, informational check could not run.
 */
export async function foreignStacksFor(
  composeProjectName: string,
  composeFileAbsPath: string,
  cli: DockerCli = realDockerCli,
): Promise<ForeignStack[]> {
  const result = await cli.run(composeLsArgs(), { timeoutMs: DOCKER_READ_TIMEOUT_MS })
  if (!result.ok) {
    logger.warn(`docker compose ls failed: ${result.stderr}`)
    return []
  }

  const parsed = safeJsonParse(result.stdout)
  if (!Array.isArray(parsed)) {
    logger.warn(
      'docker compose ls --format json did not return an array; skipping foreign-stack detection',
    )
    return []
  }

  const stacks: ForeignStack[] = []
  for (const entry of parsed) {
    const shaped = composeLsEntryRaw.safeParse(entry)
    if (!shaped.success) continue
    const name = shaped.data.Name
    if (!name || name === composeProjectName) continue

    const configFiles = (shaped.data.ConfigFiles ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!configFiles.includes(composeFileAbsPath)) continue

    stacks.push({ name, status: shaped.data.Status ?? '', configFiles })
  }
  return stacks
}
