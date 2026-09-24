// The start job itself (runEditorStart) — everything editor-op.worker.ts's
// 'start' branch delegates to. Not a leaf like container.ts: this is the
// orchestration layer that turns "start session <id>'s editor" into the
// sequence of daemon reads/writes container.ts exposes, guarded by this
// feature's own Redis lock (operations.ts) so a second start racing the first
// never runs alongside it.
//
// `deps` on the exported function is the same seam every docker-touching
// function in this codebase already uses for `cli` (see docker/cli.ts's own
// header) extended to the two calls this file makes that are not CLI
// invocations at all — probing a unix socket and sleeping between polls —
// so a test can drive the 90s health-wait loop without a real socket or a
// real 90 seconds.

import { join } from 'node:path'
import { env } from '@/env'
import { type DockerCli, realDockerCli } from '@/features/docker/cli'
import { type EditorScopeRef, editorContainerName } from '@/features/docker/names'
import { resolveDockerScope } from '@/features/docker/scope'
import { logger } from '@/lib/logger'
import { editorSocketPath, projectRepo } from '@/lib/paths'
import type { EditorOpJob } from '@/queue'
import {
  assertEditorSocketPathIsSafe,
  assertProjectsDirIsSafeForEditor,
  assertWorktreeOwnerIsRunnable,
  countRunningEditorContainers,
  editorContainerLogsTail,
  editorImageExists,
  editorInstallId,
  gitCommonDir,
  inspectEditorContainer,
  prepareEditorRuntimeDir,
  probeEditorHealthz,
  pullEditorImage,
  removeEditorContainer,
  runEditorContainer,
  worktreeOwner,
} from './container'
import {
  appendEditorOperationOutput,
  editorLockHolder,
  finishEditorOperation,
  getEditorOperation,
  markEditorOperationRunning,
  releaseEditorLock,
} from './operations'
import { seedEditorSettings } from './settings'

export type EditorStartJob = Extract<EditorOpJob, { kind: 'start' }>

/** Design step 9: "poll /healthz every 500ms up to 90s, inspect every 5th poll". */
export const HEALTHZ_POLL_INTERVAL_MS = 500
export const HEALTHZ_POLL_MAX_MS = 90_000
export const HEALTHZ_INSPECT_EVERY_N_POLLS = 5
/** How many lines of `docker logs` to capture when a start fails after the
 * container existed — enough to see the actual crash, not the whole history. */
const FAILURE_LOG_TAIL_LINES = 50
/** Stop a `docker pull` this far before the lock (and the op) would time out
 * anyway, so a failed/aborted pull still leaves time to record it as failed
 * rather than being cut off mid-write by the lock's own expiry. */
const PULL_DEADLINE_SLACK_MS = 5_000

export interface EditorLifecycleDeps {
  cli?: DockerCli
  probeHealthz?: typeof probeEditorHealthz
  sleep?: (ms: number) => Promise<void>
}

function resolveDeps(deps: EditorLifecycleDeps) {
  return {
    cli: deps.cli ?? realDockerCli,
    probeHealthz: deps.probeHealthz ?? probeEditorHealthz,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  }
}

/**
 * Run one 'start' job. See the design doc's own numbered steps — this
 * function's structure follows them in order, and each is called out below.
 */
export async function runEditorStart(
  job: EditorStartJob,
  deps: EditorLifecycleDeps = {},
): Promise<void> {
  const { cli, probeHealthz, sleep } = resolveDeps(deps)
  const { operationId, sessionId, projectId } = job

  // Step 1: confirm the lock still names this operation. A start job that
  // lost the race (its own lock expired and a later start already claimed
  // it) must not touch that later start's operation record or container —
  // it simply has nothing left to do.
  const holder = await editorLockHolder(sessionId)
  if (holder !== operationId) {
    logger.warn(
      `Editor start ${operationId} for session ${sessionId} no longer holds the lock (held by ` +
        `${holder ?? 'nobody'}); abandoning it without touching the operation record`,
    )
    return
  }

  const startedAtMs = Date.now()

  try {
    // Step 2.
    await markEditorOperationRunning(operationId)

    // Step 3: resolved again here, not trusted from the route's own read —
    // the worktree may have been removed (session deleted, project deleted)
    // in the time between the route enqueuing this job and the worker
    // actually picking it up.
    const scope = await resolveDockerScope(projectId, sessionId)
    if (scope.sessionId === null) {
      // Cannot happen through the route (which always resolves with a
      // sessionId), but keeps this function's own contract honest rather
      // than silently mounting the wrong scope if it ever did.
      throw new Error(
        `Editor start ${operationId} resolved to repo scope, not a session's worktree`,
      )
    }
    const ref: EditorScopeRef = { slug: scope.slug, sessionId: scope.sessionId }
    const name = editorContainerName(ref)
    const socketPath = editorSocketPath(sessionId)

    // Step 4: already running and answering -> nothing to do.
    const existing = await inspectEditorContainer(name, cli)
    if (existing?.state === 'running' && (await probeHealthz(socketPath, 2_000))) {
      await finishEditorOperation(operationId, 'succeeded', null)
      return
    }
    if (existing) {
      // Exited, dead, or running-but-unresponsive: never reused. `docker run
      // --name` would otherwise fail on the name already being taken, and an
      // unresponsive container is not something to leave behind either.
      await removeEditorContainer(name, cli)
    }

    // Step 5: the real cap, under this queue's own concurrency: 1 — the
    // route's own check (service.ts) is only a fast, best-effort 409. Same
    // `excludeName` as that route-side check, and for the same reason: Step 4
    // above already `docker rm -f`'d this session's own container by this
    // name, but never checked that removal's result, so if it somehow
    // survived it must still not be counted as a second container alongside
    // the one this job is about to start — see countRunningEditorContainers's
    // own comment (container.ts).
    const running = await countRunningEditorContainers(cli, { excludeName: name })
    if (running >= env.EDITOR_MAX_RUNNING) {
      await finishEditorOperation(
        operationId,
        'failed',
        `The editor container cap (${env.EDITOR_MAX_RUNNING} running) is reached`,
      )
      return
    }

    // Step 6 (folded in here): the guards the design calls out before ever
    // touching the daemon — a safe PROJECTS_DIR, a socket path AF_UNIX can
    // actually bind, an owner this process can legitimately run as, and the
    // worktree's git common dir actually belonging to this project's repo.
    assertProjectsDirIsSafeForEditor()
    assertEditorSocketPathIsSafe(socketPath)
    const owner = await worktreeOwner(scope.path)
    assertWorktreeOwnerIsRunnable(owner)
    const commonDir = await gitCommonDir(scope.path, join(projectRepo(scope.slug), '.git'))

    // Step 6: pull only if the image is not already local — this is the
    // common case after the first start on a box, and skipping it is what
    // keeps a start fast rather than re-checking the registry every time.
    //
    // The stdout lines appended at each step below exist because ONLY
    // `docker pull` used to write anything to the oplog: on the (common)
    // path where the image is already local, the start log read as
    // permanently empty ("Waiting for output\u2026") for the whole 500ms-
    // 90s health wait, which reads as hung, not merely quiet. On a start's
    // failure, the existing stderr/`docker logs` tail (below, and in
    // `waitForHealthy`) is still what actually explains it — these are
    // narration for the ordinary, successful path.
    if (await editorImageExists(env.EDITOR_IMAGE, cli)) {
      await appendEditorOperationOutput(operationId, {
        stream: 'stdout',
        text: `Image ${env.EDITOR_IMAGE} is already present`,
      })
    } else {
      await appendEditorOperationOutput(operationId, {
        stream: 'stdout',
        text: `Pulling ${env.EDITOR_IMAGE}\u2026`,
      })
      await pullImageWithDeadline(operationId, cli)
    }

    // Step 7.
    const runtimeDir = await prepareEditorRuntimeDir(sessionId, owner)
    const installId = await editorInstallId()

    // Step 7 (folded in here): seed code-server's user settings.json with
    // this install's own defaults BEFORE `docker run`, so code-server reads
    // them on its very first paint — writing this after the container
    // started would race the workbench's own load against a settings.json
    // that may not exist yet. Never fails the start: a bad defaults file (an
    // operator's override, or — a packaging bug — the shipped one) means an
    // editor with no seeded settings, not a start that never happens (see
    // the design doc's own "every editor still starts" and settings.ts).
    const settingsResult = await seedEditorSettings(runtimeDir, owner, env.EDITOR_SETTINGS_FILE)
    if (settingsResult.applied) {
      await appendEditorOperationOutput(operationId, {
        stream: 'stdout',
        text: `Applied default editor settings from ${settingsResult.label}`,
      })
    } else {
      await appendEditorOperationOutput(operationId, {
        stream: 'stderr',
        text: `Default editor settings (${settingsResult.label}) not applied: ${settingsResult.reason}`,
      })
    }

    // Step 8.
    await appendEditorOperationOutput(operationId, {
      stream: 'stdout',
      text: `Starting container ${name}`,
    })
    const runResult = await runEditorContainer(
      ref,
      {
        worktreePath: scope.path,
        gitCommonDir: commonDir,
        runtimeDir,
        uid: owner.uid,
        gid: owner.gid,
        installId,
      },
      cli,
    )
    if (!runResult.ok) {
      throw new Error(`docker run failed: ${runResult.stderr || `exit code ${runResult.exitCode}`}`)
    }

    // Step 9.
    await appendEditorOperationOutput(operationId, {
      stream: 'stdout',
      text: 'Waiting for code-server to answer\u2026',
    })
    await waitForHealthy(name, socketPath, cli, probeHealthz, sleep)

    // Step 10: the operation is finished, THEN (in the `finally` below) the
    // lock is released — never the other way around, or a status poll could
    // observe the lock gone (and so, per `deriveEditorState`, read this
    // start as abandoned) while the operation record still says `running`.
    const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1)
    await appendEditorOperationOutput(operationId, {
      stream: 'stdout',
      text: `Ready after ${elapsedSeconds}s`,
    })
    await finishEditorOperation(operationId, 'succeeded', null)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Editor start ${operationId} (session ${sessionId}) failed: ${message}`)
    await finishEditorOperation(operationId, 'failed', message)
  } finally {
    await releaseEditorLock(sessionId, operationId)
  }
}

async function pullImageWithDeadline(operationId: string, cli: DockerCli): Promise<void> {
  const op = await getEditorOperation(operationId)
  const startedAt = op ? Date.parse(op.createdAt) : Date.now()
  const deadline = startedAt + env.EDITOR_START_TIMEOUT_MS - PULL_DEADLINE_SLACK_MS
  const stream = pullEditorImage(env.EDITOR_IMAGE, cli)
  const timer = setTimeout(() => stream.close(), Math.max(0, deadline - Date.now()))
  try {
    for await (const line of stream.lines) {
      await appendEditorOperationOutput(operationId, { stream: line.stream, text: line.line })
    }
  } finally {
    clearTimeout(timer)
    stream.close()
  }
  const exitCode = await stream.exited
  if (exitCode !== 0) {
    throw new Error(`docker pull ${env.EDITOR_IMAGE} exited with code ${exitCode}`)
  }
}

async function waitForHealthy(
  name: string,
  socketPath: string,
  cli: DockerCli,
  probeHealthz: typeof probeEditorHealthz,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + HEALTHZ_POLL_MAX_MS
  let poll = 0
  while (Date.now() < deadline) {
    if (await probeHealthz(socketPath, HEALTHZ_POLL_INTERVAL_MS)) return

    poll += 1
    if (poll % HEALTHZ_INSPECT_EVERY_N_POLLS === 0) {
      const state = await inspectEditorContainer(name, cli)
      if (!state || (state.state !== 'running' && state.state !== 'created')) {
        const logs = await editorContainerLogsTail(name, FAILURE_LOG_TAIL_LINES, cli)
        throw new Error(
          `The editor container ${state ? `exited (state: ${state.state})` : 'disappeared'} ` +
            `before it became healthy:\n${logs}`,
        )
      }
    }

    await sleep(HEALTHZ_POLL_INTERVAL_MS)
  }

  const logs = await editorContainerLogsTail(name, FAILURE_LOG_TAIL_LINES, cli)
  throw new Error(`The editor did not answer /healthz within ${HEALTHZ_POLL_MAX_MS}ms:\n${logs}`)
}
