// Filesystem storage for one project's env files. No database row backs any
// of this — the directory tree under projectEnvDir(slug) *is* the store, and
// every function below either walks it or writes into it directly. That
// makes this feature's one invariant "the tree only ever holds what
// checkEnvFilePath allows", enforced here on every write and re-enforced by
// materialize.ts before anything is ever copied out of it into a session
// worktree (disk state can outlive whatever validation wrote it; see that
// module's own comment).
//
// Every path this feature touches is resolved through `storePath` below — the
// one place a caller's relPath becomes an absolute filesystem path — mirroring
// the discipline library/index.ts's `insideLibrary` and
// features/attachments/storage.ts already rely on: a bug in a caller must not
// become a path-traversal write, regardless of whether checkEnvFilePath was
// also called first.

import { randomUUID } from 'node:crypto'
import {
  chmod,
  stat as fsStat,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { projectEnvDir } from '@/lib/paths'
import { checkEnvFilePath } from './path-rules'
import type { EnvFileDto, PutEnvFileInput } from './schema'
import { ENV_FILE_MAX_FILES_PER_PROJECT } from './schema'

async function requireProject(projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw notFound('Project')
  return project
}

/**
 * Resolve `relPath` to an absolute path inside one project's env store,
 * refusing anything that would land outside it.
 *
 * Every caller below already runs `checkEnvFilePath` first, for the 400 with
 * a readable reason — this is the belt the braces above still need: a future
 * caller that forgets that check must still be unable to turn this into a
 * write (or delete) outside the store.
 */
function storePath(slug: string, relPath: string): string {
  const root = resolve(projectEnvDir(slug))
  const target = resolve(join(root, relPath))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to touch ${target}, which is outside ${root}`)
  }
  return target
}

interface WalkedFile {
  relPath: string
  size: number
  mtimeMs: number
}

/**
 * Every regular file under `dir`, as store-relative paths — the directory
 * tree is the source of truth for this feature, so listing is just walking
 * it.
 *
 * `lstat`, never `stat`: a symlink must never be followed, whichever end
 * planted it, so anything that is not a regular file or a real directory — a
 * symlink, a socket, a device node — is simply invisible here rather than
 * trusted. A missing `dir` (the common case: a project with no env files yet
 * has no `env/` directory at all) is an empty list, not an error.
 */
async function walk(dir: string, base: string): Promise<WalkedFile[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const out: WalkedFile[] = []
  for (const name of entries) {
    const abs = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push(...(await walk(abs, rel)))
    } else if (st.isFile()) {
      out.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs })
    }
    // Anything else — a symlink, a socket, a device node — is skipped.
  }
  return out
}

/** `lstat`-based existence check, consistent with `walk` above: a symlink
 * planted at this exact path does not count as "the file is here". */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** `lstat`-based directory check, the mirror of `fileExists` above — used by
 * `putEnvFile`'s own collision check, never to decide whether to *follow*
 * anything. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every stored env file's store-relative path, by project slug directly —
 * what materialize.ts calls during session creation. That caller already has
 * the project row (it needed the slug to resolve the worktree path), so a
 * second round trip through `listEnvFiles` below, keyed on a project id, buys
 * it nothing; the directory tree is the only thing left to ask.
 */
export async function listStoredPaths(slug: string): Promise<string[]> {
  return (await walk(projectEnvDir(slug), '')).map((w) => w.relPath)
}

export async function listEnvFiles(projectId: string): Promise<EnvFileDto[]> {
  const project = await requireProject(projectId)
  const root = projectEnvDir(project.slug)
  const walked = await walk(root, '')

  const files = await Promise.all(
    walked.map(
      async (w): Promise<EnvFileDto> => ({
        path: w.relPath,
        content: await readFile(join(root, w.relPath), 'utf8'),
        size: w.size,
        updatedAt: new Date(w.mtimeMs).toISOString(),
      }),
    ),
  )
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * `mkdir`, chaining down from the store root and forcing 0700 on every level
 * created. `mkdir`'s own `mode` is masked by umask — the same reason
 * features/attachments/storage.ts's `ensureUploadsDir` chmods each level
 * explicitly rather than trusting `mkdir(..., { mode })` alone — and this
 * store exists specifically to hold secrets, so nothing weaker than
 * owner-only should ever land here by accident of whatever umask the process
 * happens to run under.
 */
async function ensureStoreDir(root: string, dir: string): Promise<void> {
  const rel = relative(root, dir)
  const segments = rel === '' || rel === '.' ? [] : rel.split(sep)
  let current = root
  await mkdir(current, { recursive: true, mode: 0o700 })
  await chmod(current, 0o700)
  for (const segment of segments) {
    current = join(current, segment)
    await mkdir(current, { recursive: true, mode: 0o700 })
    await chmod(current, 0o700)
  }
}

/**
 * Write `content` to `target` via a temp file in the same directory and an
 * atomic rename — a reader (most notably a new session's materialize pass
 * running concurrently with a save here) must never observe a half-written
 * file.
 */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = dirname(target)
  const tempPath = join(dir, `.tmp-${randomUUID()}`)
  try {
    await writeFile(tempPath, content, 'utf8')
    await chmod(tempPath, 0o600)
    await rename(tempPath, target)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

// --- per-project serialization -------------------------------------------

/**
 * One chained promise per project slug — what every mutating operation
 * (`putEnvFile`, `deleteEnvFile`) below runs inside, so two calls for the
 * same project never interleave their own read-then-write.
 *
 * Without this, `putEnvFile`'s cap check races its own write: two concurrent
 * PUTs of two *different*, both-new paths can each see the store below
 * ENV_FILE_MAX_FILES_PER_PROJECT before either has written anything, and both
 * proceed — the project ends up over the cap (see this feature's own
 * concurrency test for a deterministic repro). A `Map<string, Promise>` chain
 * is enough — nothing fancier is needed — because `putEnvFile` and
 * `deleteEnvFile` only ever run in the API process: the worker's own queue
 * code (`src/worker.ts`) calls `materializeEnvFiles`, which only *reads* this
 * store, never either of these two.
 */
const projectLocks = new Map<string, Promise<void>>()

/**
 * Run `fn` only after every previously queued `fn` for this `slug` has
 * finished, success or failure — a rejection must release the lock for the
 * next caller, not hold it forever.
 */
async function withProjectLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(slug) ?? Promise.resolve()
  let release!: () => void
  // What the *next* caller for this slug waits on — a plain signal, not `fn`'s
  // own result, so this call's success or failure never has to be observed by
  // anyone but its own caller.
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  projectLocks.set(slug, next)

  await previous
  try {
    return await fn()
  } finally {
    release()
    // Drop the entry once nothing is queued behind this call — otherwise a
    // project touched once would hold a resolved promise in this map for the
    // life of the process. Only safe to delete if we are still the most
    // recent link: a caller that queued up after us has already replaced it.
    if (projectLocks.get(slug) === next) projectLocks.delete(slug)
  }
}

/**
 * Create or overwrite one env file. Creating parent directories is how the
 * UI "creates structure": saving `server/.env` for the first time creates
 * `env/server/` underneath the store root.
 */
export async function putEnvFile(projectId: string, input: PutEnvFileInput): Promise<EnvFileDto> {
  const project = await requireProject(projectId)

  // zod (envFilePathSchema) already enforces this at the HTTP boundary, but
  // this function is reachable from outside a request too, the same reason
  // createSession re-checks its own orchestrator requirement even though
  // createSessionSchema already does (see that function's own comment) —
  // belt and braces for whichever caller forgets the zod layer exists.
  const check = checkEnvFilePath(input.path)
  if (!check.ok) throw badRequest(check.reason)

  // The cap check and the write below must happen in the same critical
  // section as any file/directory collision check: all three read disk state
  // and then act on it, and none of that read-then-act is safe to run twice
  // at once for the same project.
  return withProjectLock(project.slug, async () => {
    const root = projectEnvDir(project.slug)
    const target = storePath(project.slug, input.path)

    // A store-path collision with what is already on disk — distinct from
    // the cap below, and caught here rather than left to `ensureStoreDir`'s
    // `mkdir` (ENOTDIR, saving "db.env/.env" once "db.env" is a file) or
    // `writeFileAtomic`'s `rename` (EISDIR/ENOTEMPTY, saving "x.env" once
    // "x.env/.env" made "x.env" a directory) — either of which would
    // otherwise surface as an unhandled 500 instead of a clear 409.
    const segments = input.path.split('/')
    let ancestor = root
    for (let i = 0; i < segments.length - 1; i++) {
      ancestor = join(ancestor, segments[i] as string)
      if (await fileExists(ancestor)) {
        throw conflict(
          `"${segments.slice(0, i + 1).join('/')}" is already a file, so it cannot also be a folder`,
        )
      }
    }
    if (await directoryExists(target)) {
      throw conflict(`"${input.path}" is already a folder`)
    }

    const isNew = !(await fileExists(target))
    if (isNew) {
      const count = (await walk(root, '')).length
      if (count >= ENV_FILE_MAX_FILES_PER_PROJECT) {
        throw conflict(
          `This project already has ${ENV_FILE_MAX_FILES_PER_PROJECT} env files, the maximum`,
        )
      }
    }

    await ensureStoreDir(root, dirname(target))
    await writeFileAtomic(target, input.content)

    const st = await fsStat(target)
    logger.info(`Env file "${input.path}" saved for project ${project.slug}`)
    return {
      path: input.path,
      content: input.content,
      size: st.size,
      updatedAt: st.mtime.toISOString(),
    }
  })
}

/** Idempotent in neither direction: deleting a file that is not there is a
 * 404 (the client asked to delete a specific file, and it is not there to
 * delete), unlike e.g. deleteSessionFiles, which is cleanup of a tree that is
 * expected to sometimes already be gone. */
export async function deleteEnvFile(projectId: string, relPath: string): Promise<void> {
  const project = await requireProject(projectId)

  const check = checkEnvFilePath(relPath)
  if (!check.ok) throw badRequest(check.reason)

  // Same lock putEnvFile takes: a delete shrinking the store below the cap
  // and a put's own count check must not interleave either.
  await withProjectLock(project.slug, async () => {
    const root = projectEnvDir(project.slug)
    const target = storePath(project.slug, relPath)

    if (!(await fileExists(target))) throw notFound('Env file')
    await rm(target, { force: true })

    // Prune now-empty parent directories, innermost first, so a deleted
    // `server/.env` also removes the now-empty `env/server/` — but never the
    // store root itself, even once the last file in the project is gone;
    // putEnvFile's own ensureStoreDir expects the root to already exist (or be
    // freely re-creatable), not to have been swept away by the delete path.
    let dir = dirname(target)
    while (dir !== root && dir.startsWith(root + sep)) {
      const entries = await readdir(dir).catch(() => undefined)
      if (!entries || entries.length > 0) break
      await rmdir(dir).catch(() => {})
      dir = dirname(dir)
    }

    logger.info(`Env file "${relPath}" deleted for project ${project.slug}`)
  })
}
