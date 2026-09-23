// The docker mechanics of one editor container: the argv that starts it, the
// filesystem checks a start has to pass first, and the daemon reads/writes
// lifecycle.ts drives them through.
//
// A LEAF module, like docker/containers.ts: imports only docker/{cli,names,
// inspect}, lib/paths, env and logger — never anything else under
// features/editor/, and never features/sessions/service.ts. That is what lets
// this file be reused (or reasoned about) with no dependency on this
// feature's own Redis records, queue job shape, or route layer. The
// converse — nothing under features/docker/* ever imports from
// features/editor/* — is enforced by review, not by the type system; see the
// project brief.

import { createHash } from 'node:crypto'
import { chmod, chown, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '@/env'
import {
  DOCKER_READ_TIMEOUT_MS,
  type DockerCli,
  type DockerResult,
  type DockerStream,
  realDockerCli,
} from '@/features/docker/cli'
import type { ContainerState } from '@/features/docker/inspect'
import { inspectContainers, inspectImage, listContainerIds } from '@/features/docker/inspect'
import {
  EDITOR_LABEL_FILTER,
  type EditorScopeRef,
  editorContainerName,
  editorInstallLabelFilter,
  editorLabels,
} from '@/features/docker/names'
import { logger } from '@/lib/logger'
import { editorRuntimeDir } from '@/lib/paths'

/** `docker rm -f` bound — the design's own "15s bound" for an inline stop. */
const EDITOR_RM_TIMEOUT_MS = 15_000
/** `docker run -d` returns as soon as the container is created and started in
 * the background; generous headroom over DOCKER_READ_TIMEOUT_MS (10s) for a
 * loaded host, not a value this should ever actually take. */
const EDITOR_RUN_TIMEOUT_MS = 30_000

// --- argv -----------------------------------------------------------------

export interface EditorRunOptions {
  worktreePath: string
  /** Resolved by `gitCommonDir` below — the path the worktree's own `.git`
   * file references, not necessarily `projectRepo(slug)/.git` verbatim (an
   * adopted project may symlink its repo into SOURCES_DIR). */
  gitCommonDir: string
  /** This session's own editor runtime dir (lib/paths.ts's
   * `editorRuntimeDir`) — bind-mounted whole so the container can create the
   * socket file itself; mounting the socket file directly would require it
   * to exist first, which is backwards (code-server creates it). */
  runtimeDir: string
  uid: number
  gid: number
  /** container.ts's own `editorInstallId()`, resolved by the caller (this
   * function itself stays synchronous/pure — see its own comment) and
   * stamped as the fourth editor label. */
  installId: string
}

/**
 * Pure argv builder — no I/O, mirrors docker/args.ts's own discipline: every
 * argument reaching `docker` is a plain string in this array, never a shell
 * string, so there is no interpolation point an untrusted value could hide a
 * flag in. See the design doc's "Container spec" for why each flag is here;
 * docker-container-args.test.ts snapshots this exact argv.
 */
export function editorRunArgs(ref: EditorScopeRef, opts: EditorRunOptions): string[] {
  const labels = editorLabels(ref, opts.installId).flatMap((label) => ['--label', label])
  return [
    'run',
    '-d',
    '--name',
    editorContainerName(ref),
    ...labels,
    '--init',
    '--entrypoint',
    '/usr/bin/code-server',
    '--user',
    `${opts.uid}:${opts.gid}`,
    '--network',
    'none',
    '--security-opt',
    'no-new-privileges:true',
    '--cap-drop',
    'ALL',
    '--memory',
    env.EDITOR_MEMORY_LIMIT,
    '--cpus',
    String(env.EDITOR_CPUS),
    '--pids-limit',
    '512',
    '--restart',
    'no',
    '--workdir',
    opts.worktreePath,
    '--env',
    'HOME=/tmp/home',
    '--env',
    'SHELL=/bin/bash',
    '--mount',
    `type=bind,src=${opts.worktreePath},dst=${opts.worktreePath}`,
    '--mount',
    `type=bind,src=${opts.gitCommonDir},dst=${opts.gitCommonDir}`,
    '--mount',
    `type=bind,src=${opts.runtimeDir},dst=/run/agentoo-editor`,
    env.EDITOR_IMAGE,
    '--socket',
    '/run/agentoo-editor/code-server.sock',
    '--auth',
    'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--disable-getting-started-override',
    '--disable-proxy',
    '--idle-timeout-seconds',
    String(env.EDITOR_IDLE_TIMEOUT_SECONDS),
    '--user-data-dir',
    '/tmp/home/.local/share/code-server',
    '--extensions-dir',
    '/tmp/home/.local/share/code-server/extensions',
    opts.worktreePath,
  ]
}

// --- guards -----------------------------------------------------------------

/**
 * AF_UNIX's `sun_path` is 108 bytes including the terminating NUL; 104 is the
 * design's own margin under that, byte length (not character length) because
 * a non-ASCII PROJECTS_DIR would otherwise undercount. Checked against the
 * *byte* length of the full socket path, not PROJECTS_DIR alone, since the
 * session id and filename both eat into the same budget.
 */
const MAX_SOCKET_PATH_BYTES = 104

export function assertEditorSocketPathIsSafe(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Editor socket path is too long for AF_UNIX (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`,
    )
  }
}

/**
 * `ws+unix://<sock>:<pathAndQuery>` (the proxy's own WebSocket dial — see the
 * design doc) splits on the first `:`, and `--mount type=bind,src=...` splits
 * on `,` — either character anywhere in PROJECTS_DIR would corrupt one of
 * those before this feature ever sees a client request. A deploy-time
 * constant, checked once per start rather than assumed safe forever.
 */
export function assertProjectsDirIsSafeForEditor(): void {
  if (env.PROJECTS_DIR.includes(':')) {
    throw new Error('PROJECTS_DIR must not contain ":" (it would split a ws+unix proxy URL)')
  }
  if (env.PROJECTS_DIR.includes(',')) {
    throw new Error('PROJECTS_DIR must not contain "," (it would break a --mount type=bind value)')
  }
}

/**
 * Refuse to run code-server as anyone but the worktree's own owner, unless
 * this process itself is root — running as an arbitrary other uid would
 * either fail on every file in the worktree (permission denied) or, worse,
 * succeed and write root-owned files into it. See the design doc's own
 * rationale (the fixuid bug this whole approach replaces).
 */
export function assertWorktreeOwnerIsRunnable(owner: { uid: number; gid: number }): void {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0
  if (myUid !== 0 && myUid !== owner.uid) {
    throw new Error(
      `Refusing to start the editor: the worktree is owned by uid ${owner.uid}, and this process ` +
        `runs as uid ${myUid} — neither root nor the owner`,
    )
  }
}

export async function worktreeOwner(worktreePath: string): Promise<{ uid: number; gid: number }> {
  const info = await stat(worktreePath)
  return { uid: info.uid, gid: info.gid }
}

/**
 * Create (or reuse) this session's runtime dir, 0700, owned by the worktree's
 * own uid/gid when this process can make that true (root only — an ordinary
 * service account cannot chown to a uid it is not) — code-server itself needs
 * write access to create the socket file inside it. `mkdir`'s own `mode` is
 * masked by umask, so `chmod` afterwards is what actually guarantees 0700
 * regardless of the process umask.
 */
export async function prepareEditorRuntimeDir(
  sessionId: string,
  owner: { uid: number; gid: number },
): Promise<string> {
  const dir = editorRuntimeDir(sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0
  if (myUid === 0) {
    await chown(dir, owner.uid, owner.gid)
  }
  return dir
}

/**
 * The worktree's `.git` file is a pointer (`gitdir: <path>`), not a directory,
 * and `<path>/commondir` names the shared repository `.git` directory it was
 * cut from — resolved and verified before it is ever handed to `docker run
 * --mount`, so a worktree whose registration has drifted (or been tampered
 * with) fails the start instead of silently mounting the wrong repository.
 *
 * Verified with `realpath`, but the value *returned* (and later mounted) is
 * the un-resolved `commonDir` — the literal path the `.git` file references —
 * not its realpath: an adopted project's `repo/` can itself be a symlink into
 * SOURCES_DIR, and git already recorded gitdir/commondir relative to whatever
 * `repo/` resolved to at `git worktree add` time. Mounting the realpath
 * instead would still work for git itself (same inode), but would silently
 * diverge from what every other git process — including one a human runs by
 * hand — already treats as this repository's location.
 */
export async function gitCommonDir(worktreePath: string, expectedGitDir: string): Promise<string> {
  const dotGitPath = join(worktreePath, '.git')
  const content = (await readFile(dotGitPath, 'utf8')).trim()
  const match = /^gitdir:\s*(.+)$/.exec(content)
  if (!match?.[1]) {
    throw new Error(`${dotGitPath} is not a git worktree pointer file`)
  }
  const gitDir = match[1].trim()
  const commondirRaw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
  const commonDir = resolve(gitDir, commondirRaw)

  const [realCommon, realExpected] = await Promise.all([
    realpath(commonDir).catch(() => commonDir),
    realpath(expectedGitDir).catch(() => expectedGitDir),
  ])
  if (realCommon !== realExpected) {
    throw new Error(
      `This worktree's git common dir (${commonDir}) does not resolve to this project's own repo ` +
        `(${expectedGitDir}); refusing to start the editor`,
    )
  }
  return commonDir
}

// --- daemon reads/writes ------------------------------------------------------

export interface EditorContainerState {
  id: string
  name: string
  state: ContainerState
  startedAt: string | null
}

/**
 * `docker inspect <name>` — a name works exactly like an id for this call, so
 * this reuses inspect.ts's own id-based pipeline (parsing, tolerant-decode)
 * rather than a second NDJSON reader. Returns undefined for "no such
 * container", the same as an unknown id.
 */
export async function inspectEditorContainer(
  name: string,
  cli: DockerCli = realDockerCli,
): Promise<EditorContainerState | undefined> {
  const [container] = await inspectContainers([name], cli)
  if (!container) return undefined
  return {
    id: container.id,
    name: container.name,
    state: container.state,
    startedAt: container.startedAt,
  }
}

export async function runEditorContainer(
  ref: EditorScopeRef,
  opts: EditorRunOptions,
  cli: DockerCli = realDockerCli,
): Promise<DockerResult> {
  return cli.run(editorRunArgs(ref, opts), { timeoutMs: EDITOR_RUN_TIMEOUT_MS })
}

export async function removeEditorContainer(
  name: string,
  cli: DockerCli = realDockerCli,
): Promise<DockerResult> {
  return cli.run(['rm', '-f', name], { timeoutMs: EDITOR_RM_TIMEOUT_MS })
}

/** `removeEditorContainer` by scope rather than by name — what
 * sessions/service.ts's `deleteSession` calls: it has a slug and a session
 * id on hand already (from the project row and its own session row), not a
 * container name it would otherwise have to re-derive itself. */
export async function removeEditor(
  ref: EditorScopeRef,
  cli: DockerCli = realDockerCli,
): Promise<DockerResult> {
  return removeEditorContainer(editorContainerName(ref), cli)
}

/**
 * The installation discriminator every editor container is stamped with —
 * first 12 hex of sha256(realpath(PROJECTS_DIR)) — computed once and cached
 * for the life of this process (PROJECTS_DIR does not change at runtime).
 *
 * PROJECTS_DIR, not a hostname or a pid: it is what physically separates one
 * agentoo install from another sharing this same docker daemon (this box
 * runs several — a production install plus per-worktree dev/test copies —
 * and every editor's own worktree and runtime dir already live under it), so
 * it is the one thing already guaranteed to differ between installs, with
 * nothing new to configure. `realpath` is what keeps a symlinked
 * PROJECTS_DIR agreeing with itself rather than minting a second identity
 * for the same install depending on which path was used to reach it.
 */
let cachedInstallId: Promise<string> | undefined
export function editorInstallId(): Promise<string> {
  if (!cachedInstallId) {
    cachedInstallId = realpath(env.PROJECTS_DIR)
      .catch(() => resolve(env.PROJECTS_DIR))
      .then((real) => createHash('sha256').update(real).digest('hex').slice(0, 12))
  }
  return cachedInstallId
}

/**
 * Every editor container currently `running`, across every project, session,
 * AND install — deliberately NOT narrowed to this install alone, unlike the
 * reaper's own listing below: `EDITOR_MAX_RUNNING` protects the box's shared
 * RAM, which every agentoo install on this daemon draws from together, so a
 * dev copy and the production install must count against the SAME cap, not
 * each get their own headroom on top of it.
 */
export async function countRunningEditorContainers(
  cli: DockerCli = realDockerCli,
): Promise<number> {
  const ids = await listContainerIds(EDITOR_LABEL_FILTER, cli)
  const containers = await inspectContainers(ids, cli)
  return containers.filter((c) => c.state === 'running').length
}

/**
 * Every editor container belonging to THIS install specifically — what the
 * reaper (features/editor/reaper.ts) lists, so an install sharing the
 * daemon with others never inspects, let alone removes, a sibling install's
 * containers just because its own database has never heard of their
 * sessions. Two separate `docker ps -aq --filter` calls, ids intersected
 * client-side: see `editorInstallLabelFilter`'s own comment (names.ts) for
 * why this doesn't reach for a single multi-filter `docker ps` invocation.
 */
export async function listThisInstallEditorContainerIds(
  cli: DockerCli = realDockerCli,
): Promise<string[]> {
  const installId = await editorInstallId()
  const [editorIds, installIds] = await Promise.all([
    listContainerIds(EDITOR_LABEL_FILTER, cli),
    listContainerIds(editorInstallLabelFilter(installId), cli),
  ])
  const installIdSet = new Set(installIds)
  return editorIds.filter((id) => installIdSet.has(id))
}

export async function editorImageExists(
  image: string,
  cli: DockerCli = realDockerCli,
): Promise<boolean> {
  return (await inspectImage(image, cli)).exists
}

/** A live `docker pull` — the caller (lifecycle.ts) is what actually streams
 * this into the operation's oplog and enforces the remaining-time deadline;
 * this only opens the process. */
export function pullEditorImage(image: string, cli: DockerCli = realDockerCli): DockerStream {
  return cli.stream(['pull', image])
}

export async function editorContainerLogsTail(
  name: string,
  lines: number,
  cli: DockerCli = realDockerCli,
): Promise<string> {
  const result = await cli.run(['logs', '--tail', String(lines), name], {
    timeoutMs: DOCKER_READ_TIMEOUT_MS,
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

/**
 * A single `/healthz` request over the unix socket code-server listens on —
 * this is what tells `starting` (container up, not yet answering) apart from
 * `running` (see `deriveEditorState` in service.ts). Any failure — no socket
 * file, connection refused, a timeout — reports `false`, never throws: a
 * container that has not opened its socket yet is an ordinary, expected state
 * while starting, not a fault to log.
 */
export async function probeEditorHealthz(socketPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch('http://localhost/healthz', {
      // Bun-specific `unix` fetch option (Bun >= 1.3.13; see the design doc) —
      // dialing a unix socket instead of a TCP host/port.
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { unix: string })
    return response.ok
  } catch (error) {
    logger.debug(`Editor healthz probe at ${socketPath} did not answer: ${String(error)}`)
    return false
  }
}
