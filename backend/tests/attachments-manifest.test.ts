import { expect, test } from 'bun:test'
import './setup-env'
import {
  announcementFor,
  attachmentsSystemPromptBlock,
  type ManifestFile,
  renderManifest,
} from '../src/features/attachments/manifest'

const file = (overrides: Partial<ManifestFile> = {}): ManifestFile => ({
  id: '00000000-0000-0000-0000-000000000001',
  originalFilename: 'error.log',
  mimeType: 'text/plain',
  sizeBytes: 831488, // ~812 KB
  checksum: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  lineCount: 4212,
  pageCount: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
})

test('renderManifest of an empty session is exact', () => {
  expect(renderManifest([])).toBe(
    '# Attachments\n\n' +
      'Files a human added to this session. Every subagent can read them too. This file is ' +
      'generated and read-only — do not Edit or Write it.\n\n' +
      'No files yet.\n',
  )
})

test('renderManifest renders a table row with size, extent and short checksum', () => {
  const out = renderManifest([file()])
  expect(out).toContain('| File | Type | Size | Extent | SHA-256 | Added |')
  expect(out).toContain(
    '| error.log | text/plain | 812.0 KB | 4212 lines | abcdef012345 | 2026-09-01T00:00:00.000Z |',
  )
})

test('renderManifest orders by (createdAt, id) and is byte-identical on a no-op re-render', () => {
  const older = file({
    id: '00000000-0000-0000-0000-000000000002',
    originalFilename: 'a.txt',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  const newer = file({
    id: '00000000-0000-0000-0000-000000000003',
    originalFilename: 'b.txt',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  })
  const first = renderManifest([newer, older])
  const second = renderManifest([older, newer])
  expect(first).toBe(second)
  expect(first.indexOf('a.txt')).toBeLessThan(first.indexOf('b.txt'))
})

test('renderManifest shows a page count for PDFs, not a line count', () => {
  const out = renderManifest([
    file({ originalFilename: 'spec.pdf', mimeType: 'application/pdf', lineCount: null, pageCount: 14 }),
  ])
  expect(out).toContain('14 pages')
})

test('announcementFor is empty for no files', () => {
  expect(announcementFor('/opt/agentoo/attachments/sessions/aa/bb/id/uploads', [])).toBe('')
})

test('announcementFor matches the documented shape for one file', () => {
  const dir = '/opt/agentoo/attachments/sessions/aa/bb/id/uploads'
  const out = announcementFor(dir, [file({ sizeBytes: 831488 })])
  expect(out).toBe(
    "[attachments added] 1 file is now available in this session's attachments directory\n" +
      `(${dir}):\n` +
      '- error.log — text/plain, 4212 lines, 812.0 KB\n' +
      'The full index is ATTACHMENTS.md in that directory. It is read-only.\n' +
      'Large files: use Grep, or Read with offset/limit — Read truncates past ~2000 lines or ~25k tokens.\n',
  )
})

test('announcementFor pluralises for more than one file', () => {
  const dir = '/uploads'
  const out = announcementFor(dir, [
    file({ id: '1', originalFilename: 'a.log' }),
    file({ id: '2', originalFilename: 'b.log' }),
  ])
  expect(out.startsWith('[attachments added] 2 files are now available')).toBe(true)
})

test('attachmentsSystemPromptBlock names the dir, the count and ATTACHMENTS.md, singular/plural', () => {
  const block = attachmentsSystemPromptBlock('/uploads', 1, '/uploads/ATTACHMENTS.md')
  expect(block).toContain('/uploads')
  expect(block).toContain('1 file currently')
  expect(block).toContain('/uploads/ATTACHMENTS.md')

  const plural = attachmentsSystemPromptBlock('/uploads', 3, '/uploads/ATTACHMENTS.md')
  expect(plural).toContain('3 files currently')
})
