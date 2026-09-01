import { symlink } from 'node:fs/promises'
import { Worker } from 'bullmq'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { keyPathFor } from '@/features/ssh-keys/service'
import { checkAdoptPath } from '@/lib/adopt-path'
import {
  currentBranch,
  dirExists,
  ensureDir,
  git,
  isEmptyDir,
  isGitRepo,
  recoveryCommandsFor,
  remoteUrl,
} from '@/lib/git'
import { logger } from '@/lib/logger'
import { assertInsideProjects, projectPlugin, projectRepo, projectRoot } from '@/lib/paths'
import { checkRemoteUrl, safeCloneArgs } from '@/lib/remote-url'
import { gitSshCommand } from '@/lib/ssh'
import { type ProjectSetupJob, QUEUE_PROJECT_SETUP, redisConnection } from './index'

async function fail(projectId: string, error: string, recovery?: string[]) {
  await db
    .update(projects)
    .set({
      status: recovery ? 'needs_manual' : 'failed',
      lastError: error,
      recoveryCommands: recovery ?? null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId))
}

/** Auth failures are recoverable by the user over SSH; nothing else is. */
function looksLikeAuthFailure(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('authentication failed') ||
    s.includes('permission denied') ||
    s.includes('could not read username') ||
    s.includes('could not read password') ||
    s.includes('terminal prompts disabled') ||
    s.includes('host key verification failed') ||
    s.includes('repository not found') // private repo reads as 404 when unauthenticated
  )
}

export async function runProjectSetup(job: ProjectSetupJob): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId)).limit(1)
  if (!project) {
    logger.warn(`Project ${job.projectId} vanished before setup ran`)
    return
  }

  const root = assertInsideProjects(projectRoot(project.slug))
  const repo = projectRepo(project.slug)

  await db
    .update(projects)
    .set({ status: 'cloning', updatedAt: new Date() })
    .where(eq(projects.id, project.id))

  try {
    await ensureDir(root)
    // The per-project plugin dir holds symlinks to library agents and skills.
    // It lives beside the repo so the repo's working tree is never dirtied.
    await ensureDir(projectPlugin(project.slug))
    await ensureDir(`${projectPlugin(project.slug)}/agents`)
    await ensureDir(`${projectPlugin(project.slug)}/skills`)

    if (project.source === 'existing') {
      // Adopt a directory: symlink it into place rather than copying, so the
      // user keeps working where they already were.
      if (job.existingPath && !(await dirExists(repo))) {
        // Re-validated on this side of the queue too: the job payload is data,
        // and adopting a directory grants Claude full tool access to it.
        const pathCheck = await checkAdoptPath(job.existingPath)
        if (!pathCheck.ok || !pathCheck.resolved) {
          await fail(project.id, `Refusing to adopt ${job.existingPath}: ${pathCheck.reason}`)
          logger.warn(`Rejected adopt path for ${project.slug}: ${pathCheck.reason}`)
          return
        }
        await symlink(pathCheck.resolved, repo, 'dir')
        logger.info(`Linked ${repo} -> ${pathCheck.resolved}`)
      }
    } else {
      if (!project.remoteUrl) {
        await fail(project.id, 'Project has no remote URL to clone')
        return
      }

      // Re-checked here, not only at the API boundary: this row could have been
      // written before the check existed, and `git clone` executes commands for
      // some URL shapes.
      const urlCheck = checkRemoteUrl(project.remoteUrl)
      if (!urlCheck.ok) {
        await fail(project.id, `Refusing to clone: ${urlCheck.reason}`)
        logger.warn(`Rejected remote for ${project.slug}: ${urlCheck.reason}`)
        return
      }

      const alreadyThere = (await dirExists(repo)) && !(await isEmptyDir(repo))
      if (alreadyThere) {
        // The user may have cloned it by hand after we handed them commands.
        // Adopt whatever is there rather than refusing.
        logger.info(`${repo} already populated; adopting it`)
      } else {
        await ensureDir(repo)
        // Clone with the project's key when it has one, so a private repo
        // works without touching ~/.ssh/config or an agent.
        const keyPath = await keyPathFor(project.sshKeyId)
        const result = await git(
          safeCloneArgs(project.remoteUrl, repo),
          undefined,
          keyPath ? { sshCommand: gitSshCommand(keyPath) } : {},
        )
        if (!result.ok) {
          const recovery = looksLikeAuthFailure(result.stderr)
            ? recoveryCommandsFor(project.remoteUrl, repo)
            : undefined
          if (recovery && !keyPath) {
            logger.info(`${project.slug} has no ssh key; the UI will offer to add one`)
          }
          await fail(project.id, result.stderr || 'git clone failed', recovery)
          logger.warn(`Clone failed for ${project.slug}: ${result.stderr}`)
          return
        }
      }
    }

    if (!(await dirExists(repo))) {
      await fail(project.id, `${repo} does not exist after setup`)
      return
    }

    // A project need not be a git repo at all — an empty adopted folder is
    // valid, it just cannot have per-session worktrees.
    const isRepo = await isGitRepo(repo)
    const branch = isRepo ? await currentBranch(repo) : undefined
    const remote = isRepo ? await remoteUrl(repo) : undefined

    await db
      .update(projects)
      .set({
        status: 'ready',
        defaultBranch: branch ?? null,
        remoteUrl: project.remoteUrl ?? remote ?? null,
        lastError: null,
        recoveryCommands: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id))

    logger.success(`Project ${project.slug} ready${isRepo ? ` on ${branch}` : ' (not a git repo)'}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fail(project.id, message)
    logger.error(`Setup failed for ${project.slug}: ${message}`)
  }
}

export function startProjectSetupWorker() {
  const worker = new Worker<ProjectSetupJob>(
    QUEUE_PROJECT_SETUP,
    async (job) => runProjectSetup(job.data),
    { connection: redisConnection(), concurrency: 2 },
  )
  worker.on('failed', (job, err) => logger.error(`project-setup ${job?.id} failed: ${err.message}`))
  logger.info('project-setup worker listening')
  return worker
}
