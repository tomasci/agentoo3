// `useTurnMode(sessionId)` — Code or Q&A for the next message in one session,
// held in an in-memory Jotai atom (hooks/use-turn-mode.ts), deliberately not
// persisted.
//
// Every test gets its own Jotai store, so "module state" is never shared
// between them; a fresh store is also exactly what a page reload amounts to
// for a value that lives only in memory. Every render's `(sessionId, mode)`
// pair is recorded, for the same reason tests/use-session-draft.test.tsx
// does it: `SessionRoute` renders `SessionPage` with no `key`, so a session
// switch re-renders the *same* hook instance, and no render — not even a
// transient one — may show one session's mode under another's id.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useTurnMode } from '../src/features/sessions/hooks/use-turn-mode'

let renders: [string, string][] = []
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let api: ReturnType<typeof useTurnMode>

function Probe({ sessionId }: { sessionId: string }) {
  api = useTurnMode(sessionId)
  renders.push([sessionId, api[0]])
  return null
}

let store: ReturnType<typeof createStore>
let container: HTMLDivElement
let root: Root | undefined

async function render(sessionId: string) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <Provider store={store}>
        <Probe sessionId={sessionId} />
      </Provider>,
    )
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
}

const pick = async (mode: 'code' | 'qa') => {
  await act(async () => {
    api[1](mode)
  })
}

beforeEach(() => {
  localStorage.clear()
  renders = []
  store = createStore()
})

afterEach(async () => {
  await unmount()
})

test('a session nobody has touched is in Code', async () => {
  await render('s1')
  expect(api[0]).toBe('code')
})

test('picking Q&A changes only that session, and picking Code again undoes it', async () => {
  await render('s1')
  await pick('qa')
  expect(api[0]).toBe('qa')
  await pick('code')
  expect(api[0]).toBe('code')
})

test('every session keeps its own mode: a value set in one never shows in another', async () => {
  await render('s1')
  await pick('qa')
  await render('s2')
  expect(api[0]).toBe('code')
  await pick('qa')
  await render('s3')
  expect(api[0]).toBe('code')
  await render('s1')
  expect(api[0]).toBe('qa')
  await pick('code')
  await render('s2')
  expect(api[0]).toBe('qa')
  await render('s1')
  expect(api[0]).toBe('code')
})

test('switching session on one mounted hook never renders a mode under the wrong id', async () => {
  await render('s1')
  await pick('qa')
  renders = []
  await render('s2')
  await render('s1')
  expect(renders).toEqual([
    ['s2', 'code'],
    ['s1', 'qa'],
  ])
})

test('the mode survives the page unmounting and mounting again within the same app', async () => {
  await render('s1')
  await pick('qa')
  await unmount()
  await render('s1')
  expect(api[0]).toBe('qa')
})

test('a reload — nothing carried over but localStorage — starts every session in Code, and nothing was ever written there', async () => {
  await render('s1')
  await pick('qa')
  expect(localStorage.length).toBe(0)
  await unmount()
  store = createStore()
  await render('s1')
  expect(api[0]).toBe('code')
})

test('the setter is stable for one session, and picking the current mode renders nothing new', async () => {
  await render('s1')
  const setter = api[1]
  await pick('qa')
  expect(api[1]).toBe(setter)
  const before = renders.length
  await pick('qa')
  expect(renders.length).toBe(before)
})

test('the setter follows the session id it was last rendered with', async () => {
  await render('s1')
  await render('s2')
  await pick('qa')
  await render('s1')
  expect(api[0]).toBe('code')
  await render('s2')
  expect(api[0]).toBe('qa')
})
