// The Code / Q&A switch through the real `SessionPage`: what `submit()` puts
// in the body of `POST /api/sessions/{id}/messages`, and how long the chosen
// mode lasts (hooks/use-turn-mode.ts).
//
//   M1  Code sends exactly `{ text }` — no `mode` key at all, the body every
//       client had before the field existed;
//   M2  Q&A sends `{ text, mode: 'qa' }`, the text untouched, and the mode
//       stays selected for the next send; switching back goes back to `{ text }`;
//   M3  the mode is per session, survives navigating away and back, and is
//       forgotten by a reload;
//   M4  it stays operable while the session is running, and a message sent
//       then carries the mode it was sent with;
//   M5  a failed send hands the text back and leaves the mode alone.
//
// Harness as tests/session-page-drafts.test.tsx: the real page and hooks,
// generated clients mocked per file through ./mock-module, a private `cimode`
// i18n instance, a fresh Jotai store and cleared localStorage per test.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import type { GetApiSessionsIdStatus200 as SessionDto } from '../src/shared/api/generated/types/GetApiSessionsId'
import { composerModeAtom } from '../src/shared/store/ui'
import { mockModule } from './mock-module'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const T = '2026-09-04T10:00:00.000Z'

const sessionDto = (id: string, status: SessionDto['status']): SessionDto => ({
  id,
  projectId: 'p1',
  ideaId: null,
  title: `Session ${id}`,
  status,
  orchestrator: 'claude',
  worktreePath: null,
  branch: null,
  baseBranch: null,
  baseSha: null,
  baseNote: null,
  workingDir: '/srv/alpha',
  isolated: false,
  sdkSessionId: null,
  maxBudgetUsd: null,
  lastError: null,
  messageCount: 0,
  totalCostUsd: 0,
  pendingPrompts: 0,
  createdAt: T,
  updatedAt: T,
})

// --- mocked clients ----------------------------------------------------------

let statusOf: Record<string, SessionDto['status']> = {}
let sends: { sessionId: string; body: unknown }[] = []
let sendReject: unknown = null

await mockModule('@/shared/api/generated/clients/getApiSessionsId', () => ({
  getApiSessionsId: async (opts: { path: { id: string } }) => ({
    data: sessionDto(opts.path.id, statusOf[opts.path.id] ?? 'idle'),
  }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdMessages', () => ({
  getApiSessionsIdMessages: async () => ({ data: { messages: [], hasOlder: false } }),
}))
await mockModule('@/shared/api/generated/clients/getApiSessionsIdFiles', () => ({
  getApiSessionsIdFiles: async () => ({
    data: {
      files: [],
      usage: { fileCount: 0, sizeBytes: 0, maxFiles: 20, maxSessionBytes: 1e9 },
    },
  }),
}))
await mockModule('@/shared/api/generated/clients/postApiSessionsIdMessages', () => ({
  postApiSessionsIdMessages: async (opts: { path: { id: string }; body?: unknown }) => {
    sends.push({ sessionId: opts.path.id, body: opts.body })
    if (sendReject) throw sendReject
    return { data: { id: 'x', seq: 999 } }
  },
}))

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource
afterAll(() => {
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

const { SessionPage } = await import('../src/features/sessions/components/session-page')

// --- mounting ----------------------------------------------------------------

let client: QueryClient
let store: ReturnType<typeof createStore>
let container: HTMLDivElement | undefined
let root: Root | undefined

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** Renders — or re-renders on the same root, the no-`key` session switch
 *  `SessionRoute` does — the page for `sessionId`. */
async function show(sessionId: string) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider store={store}>
          <QueryClientProvider client={client}>
            <SessionPage projectId="p1" sessionId={sessionId} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
  if (!container?.textContent?.includes(`Session ${sessionId}`)) {
    throw new Error(`session page for ${sessionId} never rendered its title`)
  }
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  container = undefined
}

/** A page reload as far as anything but localStorage goes. */
async function reload() {
  await unmount()
  client.clear()
  client = newClient()
  store = createStore()
  store.set(composerModeAtom, 'raw')
}

const textarea = () => {
  const t = container?.querySelector('textarea')
  if (!t) throw new Error('no textarea')
  return t as HTMLTextAreaElement
}
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  await act(async () => {
    setter.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function clickSend() {
  const send = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.getAttribute('aria-label') === 'sessions.send',
  )
  if (!send) throw new Error('no send button')
  await act(async () => {
    send.click()
  })
  await settle()
}
const item = (label: 'sessions.turnMode.code' | 'sessions.turnMode.qa') => {
  const found = [
    ...(container?.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group"] button') ?? []),
  ].filter((b) => b.textContent === label)
  if (found.length !== 1) throw new Error(`expected one "${label}" item, got ${found.length}`)
  return found[0] as HTMLButtonElement
}
async function pick(label: 'sessions.turnMode.code' | 'sessions.turnMode.qa') {
  await act(async () => {
    item(label).click()
  })
}
const pressed = () =>
  [...(container?.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group"] button') ?? [])]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent)

/** Every localStorage entry, key and value — a write of any kind shows up. */
const storageEntries = () => {
  const entries: [string, string | null][] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k !== null) entries.push([k, localStorage.getItem(k)])
  }
  return entries.sort()
}

const CODE = 'sessions.turnMode.code'
const QA = 'sessions.turnMode.qa'

beforeEach(() => {
  statusOf = {}
  sends = []
  sendReject = null
  localStorage.clear()
  client = newClient()
  store = createStore()
  // Every test is written against the raw textarea, not the editor.
  store.set(composerModeAtom, 'raw')
})

afterEach(async () => {
  await unmount()
  client.clear()
  document.body.replaceChildren()
})

// --- M1. Code ----------------------------------------------------------------

test('a fresh session opens in Code', async () => {
  await show('s-a')
  expect(pressed()).toEqual([CODE])
})

test('Code sends exactly { text } — no mode key in the body at all', async () => {
  await show('s-a')
  await type('  fix the build  ')
  await clickSend()
  expect(sends).toHaveLength(1)
  expect(sends[0]?.sessionId).toBe('s-a')
  expect(sends[0]?.body).toStrictEqual({ text: 'fix the build' })
  expect(Object.keys(sends[0]?.body as object)).toEqual(['text'])
})

// --- M2. Q&A -------------------------------------------------------------------

test('Q&A sends { text, mode: "qa" } with the text exactly as typed, and stays selected afterwards', async () => {
  await show('s-a')
  await pick(QA)
  expect(pressed()).toEqual([QA])
  await type('  why is the build slow?  ')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([{ text: 'why is the build slow?', mode: 'qa' }])
  expect(pressed()).toEqual([QA])

  await type('and the tests?')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([
    { text: 'why is the build slow?', mode: 'qa' },
    { text: 'and the tests?', mode: 'qa' },
  ])
})

test('the text sent in Q&A carries no instruction of the frontend\'s own', async () => {
  await show('s-a')
  await pick(QA)
  await type('what does this do?')
  await clickSend()
  expect((sends[0]?.body as { text: string }).text).toBe('what does this do?')
})

test('switching back to Code goes back to a bare { text }', async () => {
  await show('s-a')
  await pick(QA)
  await type('a question')
  await clickSend()
  await pick(CODE)
  await type('now do it')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([
    { text: 'a question', mode: 'qa' },
    { text: 'now do it' },
  ])
})

test('pressing the selected item again does not empty the selection, and the next send keeps its mode', async () => {
  await show('s-a')
  await pick(QA)
  await pick(QA)
  expect(pressed()).toEqual([QA])
  await type('still a question')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([{ text: 'still a question', mode: 'qa' }])
})

test('choosing a mode with nothing typed sends nothing', async () => {
  await show('s-a')
  await pick(QA)
  await pick(CODE)
  expect(sends).toEqual([])
})

// --- M3. per session, and its lifetime -------------------------------------------

test('the mode is per session: switching sessions on one mounted page shows each its own', async () => {
  await show('s-a')
  await pick(QA)
  await show('s-b')
  expect(pressed()).toEqual([CODE])
  await type('b is code')
  await clickSend()
  await show('s-a')
  expect(pressed()).toEqual([QA])
  await type('a is a question')
  await clickSend()
  expect(sends).toEqual([
    { sessionId: 's-b', body: { text: 'b is code' } },
    { sessionId: 's-a', body: { text: 'a is a question', mode: 'qa' } },
  ])
})

test('the mode survives leaving the page and coming back while the app stays open', async () => {
  await show('s-a')
  await pick(QA)
  await unmount()
  await show('s-a')
  expect(pressed()).toEqual([QA])
})

test('a reload puts every session back in Code, and the mode was never written to storage', async () => {
  await show('s-a')
  const before = storageEntries()
  await pick(QA)
  expect(storageEntries()).toEqual(before)
  await reload()
  await show('s-a')
  expect(pressed()).toEqual([CODE])
  await type('after the reload')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([{ text: 'after the reload' }])
})

// --- M4. while the session is running ---------------------------------------------

test('while the session is running the switch is not disabled, and a message queued then carries the mode it was sent with', async () => {
  statusOf = { 's-run': 'running' }
  await show('s-run')
  const stop = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.getAttribute('aria-label') === 'sessions.stop',
  )
  expect(stop).toBeDefined()
  for (const label of [CODE, QA] as const) expect(item(label).disabled).toBe(false)
  await pick(QA)
  await type('a question while it works')
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([{ text: 'a question while it works', mode: 'qa' }])
})

// --- M5. a failed send ---------------------------------------------------------------

test('a failed Q&A send hands the text back and leaves Q&A selected for the retry', async () => {
  sendReject = { response: { status: 500, data: { error: 'boom' } } }
  await show('s-a')
  await pick(QA)
  await type('will this fail?')
  await clickSend()
  expect(textarea().value).toBe('will this fail?')
  expect(container?.textContent ?? '').toContain('boom')
  expect(pressed()).toEqual([QA])

  sendReject = null
  await clickSend()
  expect(sends.map((s) => s.body)).toStrictEqual([
    { text: 'will this fail?', mode: 'qa' },
    { text: 'will this fail?', mode: 'qa' },
  ])
})

// --- M6. Sending with Enter --------------------------------------------------
//
// Every test above sends by clicking Send. Enter is how most messages go out,
// and it reaches `submit` by another route — the composer's key handler, and
// in visual mode CodeMirror's own keymap holding a ref to it — so a stale
// closure there would send the mode the page had when the editor mounted.

async function enterIn(el: Element) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await settle()
}

test('raw: Enter after picking Q&A sends { text, mode: "qa" }; Enter after picking Code again sends { text }', async () => {
  await show('s-a')
  await pick(QA)
  await type('a question')
  await enterIn(textarea())
  await pick(CODE)
  await type('now do it')
  await enterIn(textarea())
  expect(sends.map((s) => s.body)).toStrictEqual([
    { text: 'a question', mode: 'qa' },
    { text: 'now do it' },
  ])
})

test('visual: Enter in the editor sends the mode picked after the editor mounted', async () => {
  store.set(composerModeAtom, 'visual')
  await show('s-a')
  const content = container?.querySelector('.cm-content')
  if (!content) throw new Error('no editor content')
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content as HTMLElement)
  if (!view) throw new Error('no editor view')

  const write = async (text: string) => {
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    })
    await settle()
  }

  await pick(QA)
  await write('a question')
  await enterIn(content)
  await pick(CODE)
  await write('now do it')
  await enterIn(content)
  expect(sends.map((s) => s.body)).toStrictEqual([
    { text: 'a question', mode: 'qa' },
    { text: 'now do it' },
  ])
})
