// Filesystem storage for session attachments. Postgres holds metadata only —
// this module is the only place that ever touches the storage root or builds
// a path inside it, so a bug in a caller cannot become a path-traversal write
// (see lib/paths.ts's session-id validation for the choke point this relies
// on, and library/index.ts:18 for why that discipline exists at all here).
//
// Everything below resolves by (sessionId, fileId), never by fileId alone —
// a file id from one session must not be reachable through another.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  open as fsOpen,
  stat as fsStat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '@/env'
import { logger } from '@/lib/logger'
import {
  assertInsideAttachments,
  attachmentsManifestPath,
  sessionAttachmentsDir,
  sessionUploadsDir,
} from '@/lib/paths'
import { hasControlChars } from '@/lib/text'
import { SNIFF_HEAD_BYTES, sniff } from './sniff'

export interface StoredFile {
  fileId: string
  sessionId: string
  originalFilename: string
  storedName: string
  mimeType: string
  sizeBytes: number
  checksum: string
  lineCount: number | null
  pageCount: number | null
}

/** Thrown by `put()`. `code` is what the service layer maps onto an HTTP error. */
export class AttachmentUploadError extends Error {
  readonly code: 'too_large' | 'rejected_type'
  constructor(message: string, code: 'too_large' | 'rejected_type') {
    super(message)
    this.name = 'AttachmentUploadError'
    this.code = code
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertFileId(fileId: string): string {
  if (!UUID_RE.test(fileId)) throw new Error(`Refusing to use "${fileId}" as a file id: not a UUID`)
  return fileId
}

/**
 * Flatten a name to a safe basename. The on-disk name is generated
 * (`<file-uuid>-<this>`), so this is a display fragment, not an identity —
 * the identity that matters is the DB row and the uuid prefix.
 *
 * The flattening is load-bearing, not cosmetic: with `settingSources:
 * ['project']` and `additionalDirectories` granting an agent this directory
 * (see runner-options.ts), a `.claude/` subdirectory anywhere inside an
 * uploads dir would be loaded as a partial configuration root — skills,
 * commands and agents, from a directory a human just dropped a file into.
 * Stripping every path separator here is what makes a subdirectory of any
 * kind impossible, `.claude` included. Do not "improve" this by preserving a
 * relative path.
 */
export function sanitizeFilename(original: string): string {
  let flattened = original.replaceAll('/', '_').replaceAll('\\', '_')
  // Control characters carry no identity worth preserving, so they are
  // dropped rather than substituted — a run of them should not become a run
  // of underscores.
  flattened = Array.from(flattened)
    .filter((ch) => !hasControlChars(ch))
    .join('')
  // Whatever is left outside the safe set — unicode, spaces, quotes — also
  // collapses to '_'. This is a label; the on-disk name does not need to
  // round-trip it.
  flattened = flattened.replace(/[^A-Za-z0-9._-]/g, '_')
  // No leading dot: never a hidden file, and never a bare ".." once the
  // separator replacement above has already ruled out an actual traversal.
  flattened = flattened.replace(/^\.+/, '')
  return flattened.slice(0, 100) || 'file'
}

async function ensureSessionUploadsDir(sessionId: string): Promise<string> {
  const dir = sessionUploadsDir(sessionId)
  // mkdir's mode is masked by umask, so each level gets an explicit chmod
  // too — the same two-step pattern lib/ssh.ts's generateKey uses for its
  // own 0700 directory.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(sessionAttachmentsDir(sessionId), 0o700)
  await chmod(dir, 0o700)
  await assertInsideAttachments(dir)
  return dir
}

function textLike(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/yaml'
  )
}

/**
 * Heuristic page count for a PDF: counts `/Type /Page` object markers,
 * excluding the `/Type /Pages` tree node. Not a parser — a real one is a
 * dependency this feature does not need for a number that only ever appears
 * as a hint in ATTACHMENTS.md and the per-turn announcement.
 */
function estimatePdfPageCount(buf: Buffer): number | null {
  const text = buf.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page(?!s)\b/g)
  return matches ? matches.length : null
}

/**
 * Write a new file into a session's uploads directory.
 *
 * Streams to `.tmp-<uuid>` in the final directory, hashing and sniffing as it
 * goes, and only `rename()`s into place once the write and the fsync are both
 * done — an agent must never observe a half-written upload. Any failure along
 * the way — over the per-file cap, an unrecognised type, a disk error —
 * removes the temp file and rethrows; no partial file, no orphan row is ever
 * left for a caller to insert.
 *
 * `declaredType` is accepted for parity with the interface this is meant to
 * be swappable behind, but deliberately unused: the allowlist is decided by
 * sniffing content, never a client-declared content type.
 */
export async function put(
  sessionId: string,
  originalFilename: string,
  body: ReadableStream<Uint8Array>,
  _declaredType?: string,
): Promise<StoredFile> {
  const dir = await ensureSessionUploadsDir(sessionId)
  const fileId = randomUUID()
  const storedName = `${fileId}-${sanitizeFilename(originalFilename)}`
  const tempPath = join(dir, `.tmp-${fileId}`)
  const finalPath = join(dir, storedName)

  let handle: Awaited<ReturnType<typeof fsOpen>> | undefined
  try {
    handle = await fsOpen(tempPath, 'wx')
    await chmod(tempPath, 0o600)

    const hash = createHash('sha256')
    const head = new Uint8Array(SNIFF_HEAD_BYTES)
    let headLen = 0
    let sizeBytes = 0
    let newlines = 0
    let lastByte = -1

    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue

        sizeBytes += value.length
        if (sizeBytes > env.ATTACHMENT_MAX_BYTES) {
          throw new AttachmentUploadError(
            `Exceeds the ${env.ATTACHMENT_MAX_BYTES}-byte per-file limit`,
            'too_large',
          )
        }

        hash.update(value)
        if (headLen < head.length) {
          const n = Math.min(head.length - headLen, value.length)
          head.set(value.subarray(0, n), headLen)
          headLen += n
        }
        for (const byte of value) if (byte === 0x0a) newlines += 1
        lastByte = value[value.length - 1] ?? lastByte

        await handle.write(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    const sniffed = sniff(head.subarray(0, headLen), originalFilename)
    if (!sniffed.ok || !sniffed.mimeType) {
      throw new AttachmentUploadError(sniffed.reason ?? 'Unrecognised file type', 'rejected_type')
    }

    // fsync before rename: the rename is what makes the bytes visible under
    // their final name, so they have to actually be on disk first — otherwise
    // a crash between the two could publish a file with a hole in it.
    await handle.sync()
    await handle.close()
    handle = undefined

    const lineCount = textLike(sniffed.mimeType)
      ? sizeBytes === 0
        ? 0
        : newlines + (lastByte === 0x0a ? 0 : 1)
      : null
    const pageCount =
      sniffed.mimeType === 'application/pdf' ? estimatePdfPageCount(await readFile(tempPath)) : null

    await rename(tempPath, finalPath)

    return {
      fileId,
      sessionId,
      originalFilename,
      storedName,
      mimeType: sniffed.mimeType,
      sizeBytes,
      checksum: hash.digest('hex'),
      lineCount,
      pageCount,
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(tempPath, { force: true })
    throw error
  }
}

interface ResolvedBlob {
  path: string
  storedName: string
  /** The sanitized fragment recovered from the on-disk name. Not the true
   * original filename — that lives only in the DB — but the best this
   * filesystem-only layer can offer a caller with no DB row at hand. */
  nameFromDisk: string
}

async function resolveStoredPath(
  sessionId: string,
  fileId: string,
): Promise<ResolvedBlob | undefined> {
  assertFileId(fileId)
  const dir = sessionUploadsDir(sessionId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const prefix = `${fileId}-`
  const match = entries.find((name) => name.startsWith(prefix) && !name.startsWith('.tmp-'))
  if (!match) return undefined
  return { path: join(dir, match), storedName: match, nameFromDisk: match.slice(prefix.length) }
}

/**
 * Open a file for reading, honouring an optional byte range.
 *
 * `file` here is best-effort from the filename on disk only (see
 * `ResolvedBlob.nameFromDisk`) — a caller that already holds the DB row
 * should prefer its own `originalFilename`/`mimeType`/`checksum` over this
 * one's; this exists to make `open()` usable on its own, not to duplicate
 * what a caller with database access already has. `sizeBytes` is the one
 * field here that is always disk-truth, which is the point of calling this
 * rather than trusting a possibly-stale recorded size.
 */
export async function open(
  sessionId: string,
  fileId: string,
  range?: { start: number; end: number },
): Promise<{ file: StoredFile; stream: ReadableStream<Uint8Array> } | undefined> {
  const resolved = await resolveStoredPath(sessionId, fileId)
  if (!resolved) return undefined
  const st = await fsStat(resolved.path)
  const bunFile = Bun.file(resolved.path)
  const sliced = range ? bunFile.slice(range.start, range.end + 1) : bunFile
  return {
    file: {
      fileId,
      sessionId,
      originalFilename: resolved.nameFromDisk,
      storedName: resolved.storedName,
      mimeType: 'application/octet-stream',
      sizeBytes: st.size,
      checksum: '',
      lineCount: null,
      pageCount: null,
    },
    stream: sliced.stream(),
  }
}

/**
 * Ground truth for one file: a full re-read, re-sniff and re-hash from disk.
 * Expensive relative to `open()` on purpose — this is what gc.ts calls to
 * detect a `checksum_mismatch` or confirm a `dangling_row`, an hourly batch
 * job over the whole store, not a per-download cost. Bounded by the per-file
 * size cap, so "expensive" tops out in the tens of milliseconds.
 */
export async function stat(sessionId: string, fileId: string): Promise<StoredFile | undefined> {
  const resolved = await resolveStoredPath(sessionId, fileId)
  if (!resolved) return undefined
  const buf = await readFile(resolved.path)
  const sniffed = sniff(buf.subarray(0, SNIFF_HEAD_BYTES), resolved.nameFromDisk)
  return {
    fileId,
    sessionId,
    originalFilename: resolved.nameFromDisk,
    storedName: resolved.storedName,
    mimeType: sniffed.ok && sniffed.mimeType ? sniffed.mimeType : 'application/octet-stream',
    sizeBytes: buf.length,
    checksum: createHash('sha256').update(buf).digest('hex'),
    lineCount: null,
    pageCount: null,
  }
}

/** Idempotent: deleting a file that is already gone is not an error. */
export async function deleteFile(sessionId: string, fileId: string): Promise<void> {
  const resolved = await resolveStoredPath(sessionId, fileId)
  if (!resolved) return
  await rm(resolved.path, { force: true })
}

/**
 * Prune the two shard directories above a session's, ignoring ENOTEMPTY —
 * another session can share either one — and ENOENT, since this always runs
 * after the session directory itself is already gone.
 */
async function pruneShardDirs(sessionId: string): Promise<void> {
  const hex = sessionId.toLowerCase().replace(/-/g, '')
  const bbDir = join(env.ATTACHMENTS_DIR, 'sessions', hex.slice(0, 2), hex.slice(2, 4))
  const aaDir = join(env.ATTACHMENTS_DIR, 'sessions', hex.slice(0, 2))
  for (const dir of [bbDir, aaDir]) {
    try {
      await rmdir(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') {
        logger.warn(`Could not prune shard directory ${dir}: ${String(error)}`)
      }
    }
  }
}

/**
 * Remove every file a session has, and the session's own directory.
 *
 * Idempotent and must not throw if the directory is already gone — called
 * from deleteSession(), which must not fail the session deletion over this,
 * exactly as its worktree removal does not.
 */
export async function deleteSessionFiles(sessionId: string): Promise<void> {
  const dir = sessionAttachmentsDir(sessionId)
  await rm(dir, { recursive: true, force: true })
  await pruneShardDirs(sessionId)
}

/**
 * Regenerate ATTACHMENTS.md. The one writer, called by the *service* layer
 * after every mutation — see manifest.ts for why the content itself is
 * rendered there and not here, and features/attachments/service.ts for the
 * caller.
 */
export async function writeManifest(sessionId: string, content: string): Promise<void> {
  const dir = await ensureSessionUploadsDir(sessionId)
  const path = attachmentsManifestPath(sessionId)
  const tempPath = join(dir, `.tmp-manifest-${randomUUID()}`)
  await Bun.write(tempPath, content)
  // 0600 like every blob (see put() above) — Bun.write's mode is masked by
  // umask the same way mkdir's is, so this has to be set explicitly rather
  // than trusted to land there. Chmod before rename, not after: the rename is
  // what publishes this under its final name, so a reader must never be able
  // to observe it there at the wrong mode even for an instant.
  await chmod(tempPath, 0o600)
  await rename(tempPath, path)
}

// --- reconciliation helpers -------------------------------------------------
//
// Used only by features/attachments/gc.ts. These walk the storage root
// directly rather than through (sessionId, fileId) — that is the whole point
// of two of the four anomaly classes, which exist precisely because the
// session or file id on disk may not resolve to anything in Postgres. They
// still live here rather than being reimplemented in gc.ts, so path
// construction stays in exactly one module.

export function attachmentsRoot(): string {
  return resolve(env.ATTACHMENTS_DIR)
}

/** Every session directory under the storage root, shard structure and all. */
export async function walkSessionDirs(): Promise<{ sessionId: string; dir: string }[]> {
  const root = join(attachmentsRoot(), 'sessions')
  const out: { sessionId: string; dir: string }[] = []
  let shardA: string[]
  try {
    shardA = await readdir(root)
  } catch {
    return out
  }
  for (const aa of shardA) {
    const aaDir = join(root, aa)
    const shardB = await readdir(aaDir).catch(() => [] as string[])
    for (const bb of shardB) {
      const bbDir = join(aaDir, bb)
      const sessionDirs = await readdir(bbDir).catch(() => [] as string[])
      for (const name of sessionDirs) {
        if (!UUID_RE.test(name)) {
          logger.warn(`Skipping ${join(bbDir, name)}: not a session id`)
          continue
        }
        out.push({ sessionId: name, dir: join(bbDir, name) })
      }
    }
  }
  return out
}

export interface BlobEntry {
  /** Undefined when the on-disk name has no uuid prefix at all — still an
   * orphan blob, just one gc.ts cannot ever match to a row. */
  fileId: string | undefined
  storedName: string
  path: string
  sizeBytes: number
  mtimeMs: number
}

/** Real files in a session's uploads dir — never `.tmp-*`, never ATTACHMENTS.md. */
export async function listBlobEntries(sessionId: string): Promise<BlobEntry[]> {
  const dir = sessionUploadsDir(sessionId)
  const entries = await readdir(dir).catch(() => [] as string[])
  const out: BlobEntry[] = []
  for (const name of entries) {
    if (name.startsWith('.tmp-') || name === 'ATTACHMENTS.md') continue
    const path = join(dir, name)
    const st = await fsStat(path).catch(() => undefined)
    if (!st?.isFile()) continue
    const prefix = name.slice(0, 36)
    const fileId = UUID_RE.test(prefix) && name[36] === '-' ? prefix : undefined
    out.push({ fileId, storedName: name, path, sizeBytes: st.size, mtimeMs: st.mtimeMs })
  }
  return out
}

/** Streamed, for gc.ts's system-wide walk, which may touch far more files in
 * aggregate than a single upload ever does. */
export async function checksumFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Raw delete by an absolute path already discovered via the walk helpers
 * above — used for orphan_blob GC, where there may be no valid session or
 * file id to route through the (sessionId, fileId) functions at all. */
export async function removeBlobAt(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** Remove an orphan session directory outright, then prune its shard dirs. */
export async function removeSessionDirAt(sessionId: string, dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await pruneShardDirs(sessionId)
}
