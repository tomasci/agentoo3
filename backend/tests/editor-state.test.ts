// deriveEditorState (features/editor/service.ts) — the design doc's own
// state table, exercised for every combination: lock held always wins,
// then running+healthy, running+unhealthy, and anything else stopped.

import { expect, test } from 'bun:test'
import './setup-env'
import { deriveEditorState } from '../src/features/editor/service'

test('a held lock is always "starting", regardless of container/health', () => {
  expect(deriveEditorState({ lockHeld: true, containerState: undefined, healthy: false })).toBe(
    'starting',
  )
  expect(deriveEditorState({ lockHeld: true, containerState: 'running', healthy: true })).toBe(
    'starting',
  )
  expect(deriveEditorState({ lockHeld: true, containerState: 'exited', healthy: false })).toBe(
    'starting',
  )
})

test('no lock, running and healthy is "running"', () => {
  expect(deriveEditorState({ lockHeld: false, containerState: 'running', healthy: true })).toBe(
    'running',
  )
})

test('no lock, running but not healthy is "unresponsive"', () => {
  expect(deriveEditorState({ lockHeld: false, containerState: 'running', healthy: false })).toBe(
    'unresponsive',
  )
})

test('no lock, no container at all is "stopped"', () => {
  expect(deriveEditorState({ lockHeld: false, containerState: undefined, healthy: false })).toBe(
    'stopped',
  )
})

test('no lock, container present but not running (exited/created/dead/...) is "stopped"', () => {
  for (const state of ['created', 'restarting', 'removing', 'paused', 'exited', 'dead'] as const) {
    expect(deriveEditorState({ lockHeld: false, containerState: state, healthy: false })).toBe(
      'stopped',
    )
  }
})

test('the full table, one row at a time', () => {
  const rows: Array<[boolean, string | undefined, boolean, string]> = [
    [true, undefined, false, 'starting'],
    [true, 'running', false, 'starting'],
    [true, 'running', true, 'starting'],
    [false, 'running', true, 'running'],
    [false, 'running', false, 'unresponsive'],
    [false, 'exited', false, 'stopped'],
    [false, undefined, false, 'stopped'],
  ]
  for (const [lockHeld, containerState, healthy, expected] of rows) {
    expect(
      deriveEditorState({
        lockHeld,
        containerState: containerState as Parameters<typeof deriveEditorState>[0]['containerState'],
        healthy,
      }),
    ).toBe(expected)
  }
})
