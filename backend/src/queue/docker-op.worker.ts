// One docker mutation per job: `compose up/stop/restart/down`, or the
// plain-Dockerfile equivalent. Lives on the worker, not the API process, for
// the same reason a session turn does — see backend/README.md's "Why two
// processes" — `compose up -d --build` can take minutes and must survive an
// API restart.

import { Worker } from 'bullmq'
import { env } from '@/env'
import {
  buildArgs,
  composeDownArgs,
  composeRestartArgs,
  composeStopArgs,
  composeUpArgs,
  dockerRestartArgs,
  dockerRmArgs,
  dockerStopArgs,
  runArgs,
} from '@/features/docker/args'
import { type DockerCli, realDockerCli } from '@/features/docker/cli'
import { composeEnvFor } from '@/features/docker/compose-env'
import { inspectImage } from '@/features/docker/inspect'
import type { DockerScopeRef } from '@/features/docker/names'
import { containerName, imageReference } from '@/features/docker/names'
import {
  appendOperationOutput,
  claimOperationLock,
  dockerLockScope,
  finishOperation,
  markOperationRunning,
  releaseOperationLock,
} from '@/features/docker/operations'
import { logger } from '@/lib/logger'
import { type DockerOpJob, QUEUE_DOCKER_OP, redisConnection } from './index'

/**
 * Jobs on this queue are long-running builds and container starts, not the
 * bursty, cheap work `WORKER_CONCURRENCY` is sized for (sessions). A modest,
 * fixed cap rather than a third env knob — the brief is explicit that this
 * feature adds exactly two (`DOCKER_ENABLED`, `DOCKER_OP_TIMEOUT_MS`) and
 * nothing else — and per-project serialization is already enforced by the
 * Redis lock below regardless of how many of these run in parallel across
 * *different* projects.
 */
const CONCURRENCY = 2

interface Step {
  label: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

/** The argv sequence for one operation. Async because the dockerfile `up`
 * path decides whether it needs a build step by checking whether the image
 * already exists — a read, done here rather than by the route, since only
 * the worker knows the operation is actually about to run. */
async function stepsFor(job: DockerOpJob, cli: DockerCli): Promise<Step[]> {
  const ref: DockerScopeRef = { slug: job.slug, sessionId: job.sessionId }

  if (job.mode === 'compose') {
    if (!job.composeProjectName || !job.composeFiles) {
      throw new Error(
        `Docker operation ${job.operationId}: compose job missing project name or files`,
      )
    }
    const name = job.composeProjectName
    const files = job.composeFiles
    const services = job.services
    // Same env `getComposeConfig` (the read path) resolves the file with, so
    // a `${AGENTOO_*}` substitution never binds differently for `up` than it
    // did for whatever access URL the dashboard already showed.
    const composeEnv = composeEnvFor(ref)

    switch (job.kind) {
      case 'up':
        return [
          {
            label: 'compose up',
            args: composeUpArgs(name, files, {
              services: services.length > 0 ? services : undefined,
              build: job.build,
              forceRecreate: job.forceRecreate,
              removeOrphans: job.removeOrphans,
            }),
            cwd: job.projectPath,
            env: composeEnv,
          },
        ]
      case 'stop':
        return [
          {
            label: 'compose stop',
            args: composeStopArgs(name, files, services),
            cwd: job.projectPath,
            env: composeEnv,
          },
        ]
      case 'restart':
        return [
          {
            label: 'compose restart',
            args: composeRestartArgs(name, files, services),
            cwd: job.projectPath,
            env: composeEnv,
          },
        ]
      case 'down':
        return [
          {
            label: 'compose down',
            args: composeDownArgs(name, files, services, {
              removeVolumes: job.removeVolumes,
              removeImages: job.removeImages,
            }),
            cwd: job.projectPath,
            env: composeEnv,
          },
        ]
    }
  }

  // The plain-Dockerfile path. No env: compose-style substitution has no
  // meaning for a bare `docker build`/`docker run`.
  const name = containerName(ref)

  if (job.kind === 'stop') return [{ label: 'docker stop', args: dockerStopArgs(name) }]
  if (job.kind === 'restart') return [{ label: 'docker restart', args: dockerRestartArgs(name) }]
  if (job.kind === 'down') {
    // "docker stop then docker rm" — never `--rmi`/`-v`, per the brief:
    // Cleanup on this path never removes the image, only the container.
    return [
      { label: 'docker stop', args: dockerStopArgs(name) },
      { label: 'docker rm', args: dockerRmArgs(name) },
    ]
  }

  // 'up'
  if (job.containerPort === undefined || job.protocol === undefined) {
    throw new Error(`Docker operation ${job.operationId}: up job missing containerPort/protocol`)
  }
  const steps: Step[] = []
  const image = await inspectImage(imageReference(ref), cli)
  if (job.build || !image.exists) {
    if (!job.dockerfileAbsPath) {
      throw new Error(`Docker operation ${job.operationId}: up job missing dockerfileAbsPath`)
    }
    steps.push({
      label: 'docker build',
      args: buildArgs(ref, job.dockerfileAbsPath, job.projectPath),
    })
  }
  steps.push({
    label: 'docker run',
    args: runArgs(ref, {
      hostPort: job.hostPort,
      containerPort: job.containerPort,
      protocol: job.protocol,
    }),
  })
  return steps
}

/** Run one step, piping every line it produces into the operation's Redis
 * oplog as it arrives — not buffered until the step finishes, which is the
 * whole point of streaming a `compose up --build` that can run for minutes. */
async function runStep(step: Step, operationId: string, cli: DockerCli): Promise<number> {
  const stream = cli.stream(step.args, {
    ...(step.cwd ? { cwd: step.cwd } : {}),
    ...(step.env ? { env: step.env } : {}),
  })
  try {
    for await (const line of stream.lines) {
      await appendOperationOutput(operationId, { stream: line.stream, text: line.line })
    }
  } finally {
    stream.close()
  }
  return stream.exited
}

export async function runDockerOp(job: DockerOpJob, cli: DockerCli = realDockerCli): Promise<void> {
  const lockScope = dockerLockScope(job.projectId, job.sessionId)
  const claimed = await claimOperationLock(lockScope, job.operationId, env.DOCKER_OP_TIMEOUT_MS)
  if (!claimed) {
    // The route's own check (activeOperationForScope) is best-effort, not
    // the mutex — this is: a second job that lost the race to actually claim
    // the per-scope lock ends here rather than running alongside another
    // operation against the same containers.
    await finishOperation(
      job.operationId,
      'failed',
      null,
      'Another docker operation claimed this project first',
    )
    return
  }

  try {
    await markOperationRunning(job.operationId)

    const steps = await stepsFor(job, cli)
    let exitCode = 0
    let failure: string | null = null

    for (const step of steps) {
      exitCode = await runStep(step, job.operationId, cli)
      if (exitCode !== 0) {
        failure = `${step.label} exited with code ${exitCode}`
        break
      }
    }

    await finishOperation(job.operationId, failure ? 'failed' : 'succeeded', exitCode, failure)
  } catch (error) {
    // Anything stepsFor/runStep did not anticipate — still recorded against
    // the operation rather than left `running` forever with a job that quietly
    // failed underneath it.
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Docker operation ${job.operationId} failed unexpectedly: ${message}`)
    await finishOperation(job.operationId, 'failed', null, message)
  } finally {
    await releaseOperationLock(lockScope, job.operationId)
  }
}

export function startDockerOpWorker() {
  const worker = new Worker<DockerOpJob>(QUEUE_DOCKER_OP, (job) => runDockerOp(job.data), {
    connection: redisConnection(),
    concurrency: CONCURRENCY,
  })
  worker.on('failed', (job, error) => {
    // Reached only if runDockerOp itself threw past its own catch — every
    // foreseeable failure already lands on the operation record instead.
    logger.error(`Docker operation job ${job?.data.operationId} failed: ${error.message}`)
  })
  return worker
}
