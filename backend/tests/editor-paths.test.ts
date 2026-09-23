// lib/paths.ts's editor runtime helpers: editorRuntimeRoot/editorRuntimeDir/
// editorSocketPath. Session id validated as a UUID, same guard as every other
// id-derived path in this module (sessionAttachmentsDir, ideaAttachmentsDir).

import { join } from 'node:path'
import { expect, test } from 'bun:test'
import './setup-env'
import { MISSING_PROJECTS_DIR } from './setup-env'
import { editorRuntimeDir, editorRuntimeRoot, editorSocketPath } from '../src/lib/paths'

const SESSION_ID = '11111111-2222-4333-8444-555555555555'

test('editorRuntimeRoot is PROJECTS_DIR/.editor', () => {
  expect(editorRuntimeRoot()).toBe(join(MISSING_PROJECTS_DIR, '.editor'))
})

test('editorRuntimeDir is the runtime root plus the session id', () => {
  expect(editorRuntimeDir(SESSION_ID)).toBe(join(MISSING_PROJECTS_DIR, '.editor', SESSION_ID))
})

test('editorSocketPath is the runtime dir plus code-server.sock', () => {
  expect(editorSocketPath(SESSION_ID)).toBe(
    join(MISSING_PROJECTS_DIR, '.editor', SESSION_ID, 'code-server.sock'),
  )
})

test('a non-UUID session id is refused rather than silently joined into a path', () => {
  expect(() => editorRuntimeDir('../../etc')).toThrow()
  expect(() => editorRuntimeDir('not-a-uuid')).toThrow()
  expect(() => editorSocketPath('../../etc')).toThrow()
})

test('editorRuntimeRoot never collides with a real project directory', () => {
  // Slugs can never start with "." (toSlug() strips leading dashes/dots via
  // its NFKD + [^a-z0-9]+ collapse), so ".editor" can never be a project's
  // own projectRoot() — this is the property the design doc's own placement
  // rationale rests on.
  expect(editorRuntimeRoot()).not.toBe(join(MISSING_PROJECTS_DIR, 'editor'))
  expect(editorRuntimeRoot().split('/').pop()).toBe('.editor')
})
