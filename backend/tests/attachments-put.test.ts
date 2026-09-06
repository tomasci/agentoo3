// The storage layer against a real filesystem, under a scratch ATTACHMENTS_DIR.
//
// tests/attachments-storage.test.ts covers the pure path/name helpers; nothing
// covered `put()` itself, which is where the atomicity, the modes, the size
// cap and the sniff rejection actually live. Everything here writes real bytes
// to a real directory (see setup-env's TEST_ATTACHMENTS_DIR) and reads the
// result back with stat/readdir rather than trusting the return value.

import { afterAll, expect, test } from 'bun:test'
import './setup-env'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env } from '../src/env'
import {
  AttachmentUploadError,
  listBlobEntries,
  open as storageOpen,
  put,
  writeManifest,
} from '../src/features/attachments/storage'
import {
  assertInsideAttachments,
  attachmentsManifestPath,
  sessionUploadsDir,
} from '../src/lib/paths'

const ROOT = env.ATTACHMENTS_DIR

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

/** A fresh session id per test, so nothing here can see another test's tree. */
const newSession = () => randomUUID()

const streamOf = (...chunks: (Uint8Array | string)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      }
      controller.close()
    },
  })

/** A stream that hands over one chunk and then fails, standing for a client
 * that disconnects or a socket that resets partway through an upload. */
const failingStream = (prefix: string, message: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix))
    },
    pull() {
      throw new Error(message)
    },
  })

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const mode = async (path: string) => (await stat(path)).mode & 0o777

// --- the happy path, verified off disk rather than off the return value ------

test('put stores the bytes under <uuid>-<sanitized name> inside the session uploads dir', async () => {
  const sessionId = newSession()
  const stored = await put(sessionId, 'error.log', streamOf('alpha\nbeta\n'))

  expect(stored.storedName).toBe(`${stored.fileId}-error.log`)
  const path = join(sessionUploadsDir(sessionId), stored.storedName)
  expect(await Bun.file(path).text()).toBe('alpha\nbeta\n')
  expect(stored.sizeBytes).toBe(11)
  expect(stored.mimeType).toBe('text/plain')
  expect(stored.lineCount).toBe(2)
  expect(stored.checksum).toBe(new Bun.CryptoHasher('sha256').update('alpha\nbeta\n').digest('hex'))
})

test('a file with no trailing newline still counts its last line', async () => {
  const sessionId = newSession()
  const stored = await put(sessionId, 'a.log', streamOf('one\ntwo'))
  expect(stored.lineCount).toBe(2)
})

test('an empty file is zero lines, not one', async () => {
  const sessionId = newSession()
  const stored = await put(sessionId, 'empty.log', streamOf(''))
  expect(stored.sizeBytes).toBe(0)
  expect(stored.lineCount).toBe(0)
})

// --- modes: 0700 dirs, 0600 files, under a permissive umask ------------------

test('the session dir, the uploads dir and the blob are 0700/0700/0600', async () => {
  const previousUmask = process.umask(0o000)
  try {
    const sessionId = newSession()
    const stored = await put(sessionId, 'x.log', streamOf('x\n'))
    const uploads = sessionUploadsDir(sessionId)
    expect(await mode(uploads)).toBe(0o700)
    expect(await mode(join(uploads, '..'))).toBe(0o700)
    expect(await mode(join(uploads, stored.storedName))).toBe(0o600)
  } finally {
    process.umask(previousUmask)
  }
})

// FIXED: writeManifest() used to go through Bun.write with no chmod, so
// ATTACHMENTS.md landed 0664 while every other file in the store was 0600 —
// storage.ts:put() chmodded its temp file, writeManifest() did not. Now
// chmod'd 0600 before the rename that publishes it, the same as a blob.
test('ATTACHMENTS.md is written 0600 like every other file in the store', async () => {
  const previousUmask = process.umask(0o000)
  try {
    const sessionId = newSession()
    await put(sessionId, 'x.log', streamOf('x\n'))
    await writeManifest(sessionId, '# Attachments\n')
    expect(await mode(join(sessionUploadsDir(sessionId), 'ATTACHMENTS.md'))).toBe(0o600)
  } finally {
    process.umask(previousUmask)
  }
})

// --- atomicity ---------------------------------------------------------------

test('an upload that dies partway leaves no .tmp-* file and no file at all', async () => {
  const sessionId = newSession()
  await put(sessionId, 'first.log', streamOf('keep me\n'))

  await expect(
    put(sessionId, 'doomed.log', failingStream('half a fi', 'socket hang up')),
  ).rejects.toThrow('socket hang up')

  const entries = await readdir(sessionUploadsDir(sessionId))
  expect(entries.filter((n) => n.startsWith('.tmp-'))).toEqual([])
  expect(entries.filter((n) => n.endsWith('-doomed.log'))).toEqual([])
  expect(entries.filter((n) => n.endsWith('-first.log'))).toHaveLength(1)
})

test('a rejected type leaves nothing behind either', async () => {
  const sessionId = newSession()
  const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
  await expect(put(sessionId, 'evil.png', streamOf(gzip))).rejects.toBeInstanceOf(
    AttachmentUploadError,
  )
  expect(await readdir(sessionUploadsDir(sessionId))).toEqual([])
})

test('a file over the per-file cap is rejected and leaves nothing behind', async () => {
  const sessionId = newSession()
  const oversized = 'a'.repeat(env.ATTACHMENT_MAX_BYTES + 1)
  await expect(put(sessionId, 'big.log', streamOf(oversized))).rejects.toMatchObject({
    code: 'too_large',
  })
  expect(await readdir(sessionUploadsDir(sessionId))).toEqual([])
})

test('listBlobEntries ignores .tmp-* leftovers and ATTACHMENTS.md', async () => {
  const sessionId = newSession()
  const stored = await put(sessionId, 'real.log', streamOf('real\n'))
  await writeManifest(sessionId, '# Attachments\n')
  await writeFile(join(sessionUploadsDir(sessionId), `.tmp-${randomUUID()}`), 'in flight')

  const blobs = await listBlobEntries(sessionId)
  expect(blobs.map((b) => b.storedName)).toEqual([stored.storedName])
  expect(blobs[0]?.fileId).toBe(stored.fileId)
})

test('a blob whose name has no uuid prefix is listed with fileId undefined', async () => {
  const sessionId = newSession()
  await put(sessionId, 'real.log', streamOf('real\n'))
  await writeFile(join(sessionUploadsDir(sessionId), 'stray.log'), 'dropped in by hand')

  const stray = (await listBlobEntries(sessionId)).find((b) => b.storedName === 'stray.log')
  expect(stray).toBeDefined()
  expect(stray?.fileId).toBeUndefined()
})

// --- one session's bytes are one session's bytes ------------------------------

test('identical content in two sessions is two files with two inodes, never a hardlink', async () => {
  const a = newSession()
  const b = newSession()
  const bytes = 'the same screenshot bytes\n'
  const inA = await put(a, 'shot.log', streamOf(bytes))
  const inB = await put(b, 'shot.log', streamOf(bytes))

  expect(inA.checksum).toBe(inB.checksum)
  expect(inA.fileId).not.toBe(inB.fileId)

  const statA = await stat(join(sessionUploadsDir(a), inA.storedName))
  const statB = await stat(join(sessionUploadsDir(b), inB.storedName))
  expect(statA.ino).not.toBe(statB.ino)
  expect(statA.nlink).toBe(1)
  expect(statB.nlink).toBe(1)
})

test('a file id from session A does not resolve inside session B', async () => {
  const a = newSession()
  const b = newSession()
  const inA = await put(a, 'secret.log', streamOf('classified\n'))
  await put(b, 'other.log', streamOf('mine\n'))

  expect(await storageOpen(b, inA.fileId)).toBeUndefined()
  expect(await storageOpen(a, inA.fileId)).toBeDefined()
})

// --- path traversal in the filename ------------------------------------------

const NUL = String.fromCharCode(0)

const TRAVERSAL_NAMES: [string, string][] = [
  ['../../../../etc/cron.d/pwn', 'relative traversal'],
  ['/etc/passwd', 'an absolute path'],
  ['..\\..\\windows\\system32\\evil.dll', 'windows traversal'],
  ['.claude/skills/evil/SKILL.md', 'a partial config root'],
  ['..%2f..%2fetc%2fpasswd', 'percent-encoded traversal'],
  ['..∕etc∕passwd', 'unicode division-slash traversal'],
  [`..${NUL}/etc/passwd`, 'an embedded NUL'],
  ['．．／etc／passwd', 'fullwidth dot/slash traversal'],
]

test.each(TRAVERSAL_NAMES)(
  'a filename holding %j (%s) still lands inside the session uploads dir',
  async (name) => {
    const sessionId = newSession()
    const uploads = sessionUploadsDir(sessionId)
    const stored = await put(sessionId, name, streamOf('payload\n'))

    const path = join(uploads, stored.storedName)
    expect(path.startsWith(`${uploads}/`)).toBe(true)
    expect(await assertInsideAttachments(path)).toBe(path)
    expect(await readdir(uploads)).toEqual([stored.storedName])
    expect(stored.storedName).not.toContain('/')
    expect(stored.storedName).not.toContain('\\')
    expect(stored.storedName).not.toContain(NUL)
    // A literal '..' left in a basename is harmless once every separator is
    // gone — what matters is that the file's parent directory is the session's
    // own uploads dir and nothing else.
    expect(dirname(path)).toBe(uploads)
  },
)

// --- assertInsideAttachments --------------------------------------------------

test('assertInsideAttachments refuses a symlink pointing out of the store', async () => {
  const outside = `/tmp/agentoo-test-escape-${randomUUID()}`
  await mkdir(outside, { recursive: true })
  await mkdir(ROOT, { recursive: true })
  const link = join(ROOT, `escape-${randomUUID()}`)
  await symlink(outside, link)
  try {
    await expect(assertInsideAttachments(link)).rejects.toThrow(/outside/)
  } finally {
    await rm(link, { force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('assertInsideAttachments accepts the store root and a directory under it', async () => {
  const sessionId = newSession()
  await put(sessionId, 'x.log', streamOf('x\n'))
  await expect(assertInsideAttachments(sessionUploadsDir(sessionId))).resolves.toBeString()
  await expect(assertInsideAttachments(ROOT)).resolves.toBeString()
})

// --- a large file is reachable without reading all of it ----------------------

test('a large log is readable by byte range without loading the whole file', async () => {
  const sessionId = newSession()
  const line = 'x'.repeat(99)
  const body = `${Array.from({ length: 5000 }, (_, i) => `${i} ${line}`).join('\n')}\n`
  const stored = await put(sessionId, 'huge.log', streamOf(body))
  expect(stored.lineCount).toBe(5000)
  expect(stored.sizeBytes).toBeGreaterThan(500_000)

  const opened = await storageOpen(sessionId, stored.fileId, { start: 0, end: 8 })
  expect(opened).toBeDefined()
  const head = await new Response(opened?.stream).text()
  expect(head).toBe('0 xxxxxxx')
  // Disk-truth size, so a caller can decide to page rather than slurp.
  expect(opened?.file.sizeBytes).toBe(stored.sizeBytes)
})

// --- content sniffing decides the type, not the extension ---------------------

// FIXED: acceptance criterion 14 asks for a `.png` that is really a shell
// script to be *rejected*. sniff.ts used to allow any valid UTF-8 with no
// magic number and never compared the sniffed type against the extension, so
// this used to be accepted and stored as text/plain under the name
// screenshot.png — misclassified as nothing in particular, but never refused.
// Now an extension that promises a specific binary format (png/jpg/jpeg/
// gif/webp/pdf) is rejected outright when the content does not match it; see
// sniff.ts's PROMISED_BINARY_TYPE.
test('a .png that is really a shell script is rejected', async () => {
  const sessionId = newSession()
  await expect(
    put(sessionId, 'screenshot.png', streamOf('#!/bin/sh\necho pwned\n')),
  ).rejects.toBeInstanceOf(AttachmentUploadError)
})

test('the rejection names both what the extension claimed and what was found', async () => {
  const sessionId = newSession()
  const rejected = await put(
    sessionId,
    'screenshot.png',
    streamOf('#!/bin/sh\necho pwned\n'),
  ).catch((error: unknown) => error)
  expect(rejected).toBeInstanceOf(AttachmentUploadError)
  expect((rejected as Error).message).toContain('image/png')
  expect((rejected as Error).message).toContain('text/plain')
})

test('a .jpg that is really a PDF is rejected, not silently reclassified', async () => {
  const sessionId = newSession()
  const pdf = '%PDF-1.7\n/Type /Pages\n/Type /Page\n%%EOF\n'
  await expect(put(sessionId, 'photo.jpg', streamOf(pdf))).rejects.toBeInstanceOf(
    AttachmentUploadError,
  )
})

test('a .log that is really a PDF is classified as a PDF, pages and all', async () => {
  const sessionId = newSession()
  const pdf = '%PDF-1.7\n/Type /Pages\n/Type /Page\n/Type /Page\n%%EOF\n'
  const stored = await put(sessionId, 'notes.log', streamOf(pdf))
  expect(stored.mimeType).toBe('application/pdf')
  expect(stored.pageCount).toBe(2)
  expect(stored.lineCount).toBeNull()
})

test('a .txt that is really a PNG is classified as a PNG', async () => {
  const sessionId = newSession()
  const stored = await put(sessionId, 'readme.txt', streamOf(PNG_MAGIC, 'trailing\n'))
  expect(stored.mimeType).toBe('image/png')
})

test('a binary with no allowlisted magic number is rejected whatever it is called', async () => {
  const sessionId = newSession()
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00])
  await expect(put(sessionId, 'notes.md', streamOf(elf))).rejects.toBeInstanceOf(
    AttachmentUploadError,
  )
})

// --- the session id is validated before it can reach join() -------------------
//
// This repo has a scar for skipping exactly this step: library/index.ts:18's
// `insideLibrary` exists because a path built from an unchecked name became an
// arbitrary file write. A validated UUID cannot hold a separator or a `..`, so
// every path derived from one is safe by construction rather than by a prefix
// check bolted on afterwards.

const HOSTILE_SESSION_IDS = [
  '../../etc',
  '/etc/passwd',
  '..',
  '.',
  '',
  'not-a-uuid',
  `${'ab12cd34-ef56-7890-abcd-ef1234567890'}/../..`,
  `ab12cd34-ef56-7890-abcd-ef1234567890${NUL}`,
  '%2e%2e%2f%2e%2e',
  'ab12cd34-ef56-7890-abcd-ef123456789',
  'ab12cd34_ef56_7890_abcd_ef1234567890',
]

test.each(HOSTILE_SESSION_IDS)('%j is refused as a session id by every path builder', (id) => {
  expect(() => sessionUploadsDir(id)).toThrow(/not a UUID/)
  expect(() => attachmentsManifestPath(id)).toThrow(/not a UUID/)
})

test('put refuses a hostile session id before it creates anything', async () => {
  const before = await readdir(ROOT).catch(() => [] as string[])
  await expect(put('../../etc', 'passwd', streamOf('root:x:0:0\n'))).rejects.toThrow(/not a UUID/)
  expect(await readdir(ROOT).catch(() => [] as string[])).toEqual(before)
})

test('an uppercase uuid is accepted and sharded on its lowercase hex', () => {
  const upper = 'AB12CD34-EF56-7890-ABCD-EF1234567890'
  expect(sessionUploadsDir(upper)).toBe(`${ROOT}/sessions/ab/12/${upper}/uploads`)
})

test.each(['not-a-uuid', '../../etc', '', `${'ab12cd34-ef56-7890-abcd-ef1234567890'}/..`])(
  'a file id of %j is refused rather than resolved',
  async (fileId) => {
    const sessionId = newSession()
    await put(sessionId, 'x.log', streamOf('x\n'))
    await expect(storageOpen(sessionId, fileId)).rejects.toThrow(/not a UUID/)
  },
)
