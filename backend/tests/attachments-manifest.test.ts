import { expect, test } from 'bun:test'
import './setup-env'
import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import {
  announcementFor,
  attachmentsSystemPromptBlock,
  type ManifestFile,
  renderManifest,
} from '../src/features/attachments/manifest'
import { put } from '../src/features/attachments/storage'
import { sessionAttachmentsDir, sessionUploadsDir } from '../src/lib/paths'

const UPLOADS_DIR = '/opt/agentoo/attachments/sessions/aa/bb/id/uploads'

const file = (overrides: Partial<ManifestFile> = {}): ManifestFile => ({
  id: '00000000-0000-0000-0000-000000000001',
  originalFilename: 'error.log',
  storedName: '00000000-0000-0000-0000-000000000001-error.log',
  mimeType: 'text/plain',
  sizeBytes: 831488, // ~812 KB
  checksum: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  lineCount: 4212,
  pageCount: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
})

test('renderManifest of an empty session is exact', () => {
  expect(renderManifest(UPLOADS_DIR, [])).toBe(
    '# Attachments\n\n' +
      'Files a human added to this session. Every subagent can read them too. This file is ' +
      'generated and read-only — do not Edit or Write it.\n\n' +
      'No files yet.\n',
  )
})

test('renderManifest renders a table row with the absolute path, size, extent and short checksum', () => {
  const out = renderManifest(UPLOADS_DIR, [file()])
  expect(out).toContain('| Path | File | Type | Size | Extent | SHA-256 | Added |')
  expect(out).toContain(
    `| ${UPLOADS_DIR}/00000000-0000-0000-0000-000000000001-error.log | error.log | text/plain | ` +
      '812.0 KB | 4212 lines | abcdef012345 | 2026-09-01T00:00:00.000Z |',
  )
})

test('renderManifest orders by (createdAt, id) and is byte-identical on a no-op re-render', () => {
  const older = file({
    id: '00000000-0000-0000-0000-000000000002',
    originalFilename: 'a.txt',
    storedName: '00000000-0000-0000-0000-000000000002-a.txt',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  const newer = file({
    id: '00000000-0000-0000-0000-000000000003',
    originalFilename: 'b.txt',
    storedName: '00000000-0000-0000-0000-000000000003-b.txt',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  })
  const first = renderManifest(UPLOADS_DIR, [newer, older])
  const second = renderManifest(UPLOADS_DIR, [older, newer])
  expect(first).toBe(second)
  expect(first.indexOf('a.txt')).toBeLessThan(first.indexOf('b.txt'))
})

test('renderManifest shows a page count for PDFs, not a line count', () => {
  const out = renderManifest(UPLOADS_DIR, [
    file({
      originalFilename: 'spec.pdf',
      storedName: '00000000-0000-0000-0000-000000000001-spec.pdf',
      mimeType: 'application/pdf',
      lineCount: null,
      pageCount: 14,
    }),
  ])
  expect(out).toContain('14 pages')
})

test('announcementFor is empty for no files', () => {
  expect(announcementFor(UPLOADS_DIR, [])).toBe('')
})

test('announcementFor matches the documented shape for one file, path first', () => {
  const out = announcementFor(UPLOADS_DIR, [file({ sizeBytes: 831488 })])
  expect(out).toBe(
    "[attachments added] 1 file is now available in this session's attachments directory\n" +
      `(${UPLOADS_DIR}):\n` +
      `- ${UPLOADS_DIR}/00000000-0000-0000-0000-000000000001-error.log — error.log, text/plain, ` +
      '4212 lines, 812.0 KB\n' +
      'The full index is ATTACHMENTS.md in that directory. It is read-only.\n' +
      'Large files: use Grep, or Read with offset/limit — Read truncates past ~2000 lines or ~25k tokens.\n',
  )
})

test('announcementFor pluralises for more than one file', () => {
  const dir = '/uploads'
  const out = announcementFor(dir, [
    file({ id: '1', originalFilename: 'a.log', storedName: '1-a.log' }),
    file({ id: '2', originalFilename: 'b.log', storedName: '2-b.log' }),
  ])
  expect(out.startsWith('[attachments added] 2 files are now available')).toBe(true)
})

test('attachmentsSystemPromptBlock names the dir, the count and ATTACHMENTS.md, singular/plural', () => {
  const block = attachmentsSystemPromptBlock('/uploads', 1, '/uploads/ATTACHMENTS.md')
  expect(block).toContain('/uploads')
  expect(block).toContain('1 file currently')
  expect(block).toContain('/uploads/ATTACHMENTS.md')
  expect(block).toContain('prefixed with a file id')

  const plural = attachmentsSystemPromptBlock('/uploads', 3, '/uploads/ATTACHMENTS.md')
  expect(plural).toContain('3 files currently')
})

// --- the cross-check the bug above needed: an emitted path must resolve -----
//
// Every previous test in this file asserted an exact rendered string, but
// none of them ever checked that string against a real filesystem — which is
// exactly how a manifest that printed originalFilename alone shipped: the
// rendered output "looked right" and the path it told the agent to Read never
// existed. This test closes that gap end to end: a real file lands in a
// scratch ATTACHMENTS_DIR via storage.put(), both renderers run on the row
// that produced, and every absolute path either one prints is stat()'d for
// real. It must keep holding regardless of how the on-disk naming scheme
// changes later — it does not know or care what that scheme is, only that
// what gets printed exists.
function extractPaths(text: string, uploadsDir: string): string[] {
  const escaped = uploadsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(new RegExp(`${escaped}/[^\\s|]+`, 'g')) ?? []
}

test('every absolute path announcementFor and renderManifest print for a real upload exists on disk', async () => {
  const sessionId = randomUUID()
  try {
    const bytes = new TextEncoder().encode('hello from a real upload\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const stored = await put(sessionId, 'IMG_0162 has spaces.txt', stream)
    const uploadsDir = sessionUploadsDir(sessionId)

    const row: ManifestFile = {
      id: stored.fileId,
      originalFilename: stored.originalFilename,
      storedName: stored.storedName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      lineCount: stored.lineCount,
      pageCount: stored.pageCount,
      createdAt: new Date(),
    }

    const announcement = announcementFor(uploadsDir, [row])
    const manifest = renderManifest(uploadsDir, [row])

    const announcementPaths = extractPaths(announcement, uploadsDir)
    const manifestPaths = extractPaths(manifest, uploadsDir)
    // Each surface must actually mention a path — an empty match here would
    // make every stat() below vacuously pass.
    expect(announcementPaths.length).toBeGreaterThan(0)
    expect(manifestPaths.length).toBeGreaterThan(0)

    for (const path of [...announcementPaths, ...manifestPaths]) {
      const info = await stat(path)
      expect(info.isFile()).toBe(true)
    }
  } finally {
    await rm(sessionAttachmentsDir(sessionId), { recursive: true, force: true })
  }
})
