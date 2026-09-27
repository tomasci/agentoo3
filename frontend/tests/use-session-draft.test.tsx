// `useSessionDraft(sessionId)` — the composer's own text for one session,
// persisted through lib/drafts.ts (tests/session-drafts-lib.test.ts covers
// the storage rules themselves).
//
// The hazard this hook exists to avoid: `SessionRoute` renders `SessionPage`
// with no `key`, so switching sessions re-renders the *same* hook instance
// with a new id. Every render's `(sessionId, text)` pair is recorded below,
// so a test can assert that no render — not even one transient render before
// an effect corrects it — ever shows one session's text under another id.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionDraft } from '../src/features/sessions/hooks/use-session-draft'
import { updateDraft } from '../src/features/sessions/lib/drafts'

const key = (id: string) => `agentoo:draft:${id}`
const stored = (id: string): unknown => {
  const raw = localStorage.getItem(key(id))
  return raw === null ? null : JSON.parse(raw)
}

let renders: [string, string][] = []
// biome-ignore lint/style/useConst: reassigned by <Probe> on every render
let api: ReturnType<typeof useSessionDraft>

function Probe({ sessionId }: { sessionId: string }) {
  api = useSessionDraft(sessionId)
  renders.push([sessionId, api.text])
  return null
}

let container: HTMLDivElement
let root: Root | undefined

async function render(sessionId: string) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe sessionId={sessionId} />)
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
}

beforeEach(() => {
  localStorage.clear()
  renders = []
})

afterEach(async () => {
  await unmount()
})

test('a fresh mount with nothing stored shows an empty box', async () => {
  await render('s1')
  expect(api.text).toBe('')
})

test('typing writes localStorage synchronously, before any re-render', async () => {
  await render('s1')
  // Deliberately *not* inside act(): the write has to have happened by the
  // time setText returns, not on some later commit.
  api.setText('hel')
  expect(stored('s1')).toEqual({ text: 'hel', fileIds: [] })
  await act(async () => {})
  expect(api.text).toBe('hel')
})

test('a functional update sees the current stored text', async () => {
  await render('s1')
  await act(async () => {
    api.setText('ab')
  })
  await act(async () => {
    api.setText((current) => `${current}c`)
  })
  expect(api.text).toBe('abc')
  expect(stored('s1')).toEqual({ text: 'abc', fileIds: [] })
})

test('the conditional restore the page uses only fills an empty box', async () => {
  // session-page.tsx's send-failure path: `setText(cur => cur === '' ? value : cur)`.
  await render('s1')
  await act(async () => {
    api.setText((cur) => (cur === '' ? 'restored' : cur))
  })
  expect(api.text).toBe('restored')
  await act(async () => {
    api.setText('typed next')
  })
  await act(async () => {
    api.setText((cur) => (cur === '' ? 'restored' : cur))
  })
  expect(api.text).toBe('typed next')
})

test('a new mount reads the text stored by a previous one', async () => {
  await render('s1')
  await act(async () => {
    api.setText('keep me')
  })
  await unmount()
  renders = []
  await render('s1')
  expect(api.text).toBe('keep me')
  // Right from the first render, not after an effect catches up.
  expect(renders[0]).toEqual(['s1', 'keep me'])
})

test('typing text keeps fileIds the tray already stored for this session', async () => {
  updateDraft('s1', { fileIds: ['f1'] })
  await render('s1')
  await act(async () => {
    api.setText('x')
  })
  expect(stored('s1')).toEqual({ text: 'x', fileIds: ['f1'] })
  await act(async () => {
    api.setText('')
  })
  // Text cleared, attachment still pending: the draft must survive.
  expect(stored('s1')).toEqual({ text: '', fileIds: ['f1'] })
})

test('a fileIds-only write elsewhere does not disturb the text shown', async () => {
  await render('s1')
  await act(async () => {
    api.setText('hello')
  })
  await act(async () => {
    updateDraft('s1', { fileIds: ['f9'] })
  })
  expect(api.text).toBe('hello')
})

test('a write from outside the hook (another writer) is reflected in the rendered text', async () => {
  await render('s1')
  await act(async () => {
    updateDraft('s1', { text: 'from elsewhere' })
  })
  expect(api.text).toBe('from elsewhere')
})

test("switching sessionId on the same instance shows the new session's text on that very render", async () => {
  updateDraft('A', { text: 'alpha draft' })
  updateDraft('B', { text: 'beta draft' })
  await render('A')
  expect(api.text).toBe('alpha draft')

  const from = renders.length
  await render('B')
  const afterSwitch = renders.slice(from)
  // Every render under the new id — first one included — shows B's text.
  expect(afterSwitch.length).toBeGreaterThan(0)
  expect(afterSwitch.every(([id, text]) => id === 'B' && text === 'beta draft')).toBe(true)
  // And across the whole history, A's text never appeared under B's id.
  expect(renders.filter(([id, text]) => id === 'B' && text === 'alpha draft')).toEqual([])
})

test('switching to a session with no draft shows an empty box immediately, never the old text', async () => {
  updateDraft('A', { text: 'alpha draft' })
  await render('A')
  const from = renders.length
  await render('C')
  expect(renders.slice(from).every(([id, text]) => id === 'C' && text === '')).toBe(true)
})

test('after a switch, writes go to the new session only; the old key is untouched', async () => {
  updateDraft('A', { text: 'alpha draft', fileIds: ['a1'] })
  await render('A')
  const rawA = localStorage.getItem(key('A'))
  await render('B')

  await act(async () => {
    api.setText('typed in B')
  })
  expect(stored('B')).toEqual({ text: 'typed in B', fileIds: [] })
  expect(localStorage.getItem(key('A'))).toBe(rawA)

  // And after switching back, A shows its own text again, B keeps its own.
  await render('A')
  expect(api.text).toBe('alpha draft')
  expect(stored('B')).toEqual({ text: 'typed in B', fileIds: [] })
})

test('after a switch, a write to the old session no longer re-renders with its text', async () => {
  await render('A')
  await render('B')
  const from = renders.length
  await act(async () => {
    updateDraft('A', { text: 'late A write' })
  })
  expect(renders.slice(from).some(([, text]) => text === 'late A write')).toBe(false)
  expect(api.text).toBe('')
})

test('a setText captured before the switch still writes to the session it was created for', async () => {
  // The callback identity is keyed on sessionId: a handler bound under A (a
  // stale closure in some child) must not start writing into B's draft.
  await render('A')
  const setA = api.setText
  await render('B')
  await act(async () => {
    setA('late for A')
  })
  expect(stored('A')).toEqual({ text: 'late for A', fileIds: [] })
  expect(localStorage.getItem(key('B'))).toBeNull()
  expect(api.text).toBe('')
})
