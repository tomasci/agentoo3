// Pure argv builders — no I/O, nothing here spawns anything. This is the
// feature's real security boundary: every argument reaching `docker` is
// assembled here as a plain string array, never a shell string, and every
// compose invocation carries an explicit `-f`/`-p` rather than leaning on the
// CLI's own file discovery or its default project name (which is the same
// `repo` basename for every project on this box — see names.ts).
//
// docker-args.test.ts asserts exact argv for every function here: that is
// what pins the security property (no shell, no flag an operator-supplied
// value could be smuggled in as) as well as the behaviour.

import type { DockerScopeRef } from './names'
import { containerName, imageReference, managedLabels } from './names'

export interface ComposeFiles {
  base: string
  override?: string
}

/**
 * `-f <base> [-f <override>] -p <name>`, in that order — shared by every
 * compose subcommand below so the files-and-project-name prefix can never
 * drift between them.
 */
function composePrefix(composeProjectName: string, files: ComposeFiles): string[] {
  return [
    '-f',
    files.base,
    ...(files.override ? ['-f', files.override] : []),
    '-p',
    composeProjectName,
  ]
}

export function composeConfigArgs(composeProjectName: string, files: ComposeFiles): string[] {
  return ['compose', ...composePrefix(composeProjectName, files), 'config', '--format', 'json']
}

/** Degraded fallback when the installed Compose has no `config --format json`. */
export function composeConfigServicesArgs(
  composeProjectName: string,
  files: ComposeFiles,
): string[] {
  return ['compose', ...composePrefix(composeProjectName, files), 'config', '--services']
}

export interface ComposeUpOptions {
  services?: string[]
  build?: boolean
  forceRecreate?: boolean
  removeOrphans?: boolean
}

export function composeUpArgs(
  composeProjectName: string,
  files: ComposeFiles,
  opts: ComposeUpOptions,
): string[] {
  return [
    'compose',
    ...composePrefix(composeProjectName, files),
    'up',
    '-d',
    ...(opts.build ? ['--build'] : []),
    ...(opts.forceRecreate ? ['--force-recreate'] : []),
    ...(opts.removeOrphans ? ['--remove-orphans'] : []),
    ...(opts.services ?? []),
  ]
}

export function composeStopArgs(
  composeProjectName: string,
  files: ComposeFiles,
  services: string[],
): string[] {
  return ['compose', ...composePrefix(composeProjectName, files), 'stop', ...services]
}

export function composeRestartArgs(
  composeProjectName: string,
  files: ComposeFiles,
  services: string[],
): string[] {
  return ['compose', ...composePrefix(composeProjectName, files), 'restart', ...services]
}

export interface ComposeDownOptions {
  removeVolumes?: boolean
  removeImages?: boolean
}

/**
 * `down` alone removes containers and the compose-created network; it never
 * touches images or volumes unless asked, which is the point — Cleanup must
 * not silently delete a volume holding a database nobody meant to wipe.
 * Trailing `services`, same as `stop`/`restart` above: omitted (the common
 * "tear down the whole stack" case) is the whole point of Cleanup.
 */
export function composeDownArgs(
  composeProjectName: string,
  files: ComposeFiles,
  services: string[],
  opts: ComposeDownOptions,
): string[] {
  return [
    'compose',
    ...composePrefix(composeProjectName, files),
    'down',
    ...(opts.removeVolumes ? ['-v'] : []),
    ...(opts.removeImages ? ['--rmi', 'all'] : []),
    ...services,
  ]
}

/** No `-p`/`-f`: this lists every stack the daemon knows about, ours included,
 * which is exactly what foreign-stack detection needs to see. */
export function composeLsArgs(): string[] {
  return ['compose', 'ls', '--format', 'json']
}

export function composeVersionArgs(): string[] {
  return ['compose', 'version', '--format', 'json']
}

export function versionArgs(): string[] {
  return ['version', '--format', '{{json .}}']
}

/** Multiple `--filter label=` values are ANDed by docker, not ORed — callers
 * needing "either label" run this twice and merge the ids themselves. */
export function psFilterArgs(filter: string): string[] {
  return ['ps', '-aq', '--filter', filter]
}

/** Cap at 200 ids per the brief: one inspect call, not one per container. */
export function inspectArgs(containerIds: string[]): string[] {
  return ['inspect', '--type', 'container', '--format', '{{json .}}', ...containerIds.slice(0, 200)]
}

export function imageInspectArgs(reference: string): string[] {
  return ['image', 'inspect', '--format', '{{json .}}', reference]
}

// --- the plain-Dockerfile path --------------------------------------------

export function buildArgs(
  ref: DockerScopeRef,
  dockerfileAbsPath: string,
  projectAbsPath: string,
): string[] {
  return ['build', '-t', imageReference(ref), '-f', dockerfileAbsPath, projectAbsPath]
}

export interface RunOptions {
  /** `undefined` means "let the daemon allocate" — passed through as host port 0. */
  hostPort?: number
  containerPort: number
  protocol: 'tcp' | 'udp'
}

/**
 * No `--restart` policy, deliberately: a container this dashboard started must
 * not silently outlive a reboot the operator never asked it to survive.
 */
export function runArgs(ref: DockerScopeRef, opts: RunOptions): string[] {
  const labels = managedLabels(ref).flatMap((label) => ['--label', label])
  return [
    'run',
    '-d',
    '--name',
    containerName(ref),
    ...labels,
    '-p',
    `${opts.hostPort ?? 0}:${opts.containerPort}/${opts.protocol}`,
    imageReference(ref),
  ]
}

export function dockerStopArgs(name: string): string[] {
  return ['stop', name]
}

export function dockerRestartArgs(name: string): string[] {
  return ['restart', name]
}

export function dockerRmArgs(name: string): string[] {
  return ['rm', name]
}

export interface LogsOptions {
  tail: number
  since?: string
}

export function logsArgs(containerId: string, opts: LogsOptions): string[] {
  return [
    'logs',
    '--follow',
    '--timestamps',
    '--tail',
    String(opts.tail),
    ...(opts.since ? ['--since', opts.since] : []),
    containerId,
  ]
}
