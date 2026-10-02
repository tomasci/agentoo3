// The Env files page (`EnvFilesPage`, route `/projects/$projectId/env`): a
// project's store of env files that the backend copies into every new
// session worktree.
//
// Mocked at the HTTP transport rather than at the generated client modules:
// a real `axios` instance with a fake adapter is swapped into the shared
// generated client (`apiClient.setConfig({ transport })`, the same seam
// tests/editor-page.test.tsx uses for its offline transport). That keeps the
// generated clients, their URL/query serialisation, axios's own error
// objects and the client's `ResponseError` wrapping all real, so the
// assertions below are about the request the browser would actually send
// (`DELETE /api/projects/p1/env-files?path=server%2F.env`) and the error
// envelope the backend actually answers with (`{ error: "..." }`).
//
// The fake keeps a tiny in-memory store with the backend's semantics — GET
// sorted by path, PUT an upsert, DELETE a removal — so refetches after a
// mutation show what the server would.
//
// Rendered against a private English i18next instance (not the app's
// process-wide singleton — see tests/ports-page.test.tsx's header) so the
// assertions read like the UI does.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import i18next from 'i18next'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { EnvFilesPage } from '../src/features/env-files'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import en from '../src/shared/i18n/locales/en.json'
import { Toaster, toast } from '../src/shared/ui/toast'

const PROJECT = 'p1'
const BASE = `/api/projects/${PROJECT}/env-files`
const T = '2026-10-01T12:00:00.000Z'

// ── fake backend ────────────────────────────────────────────────────────────

interface StoredFile {
  path: string
  content: string
  size: number
  updatedAt: string
}
interface Call {
  method: string
  url: string
  body: unknown
}

let store = new Map<string, StoredFile>()
let calls: Call[] = []
/** Per-method override: answer with this status/body instead of the store. */
let failNext: Partial<Record<string, { status: number; data: unknown }>> = {}
/** When set for a method, that method's request waits on it. */
let gates: Partial<Record<string, Promise<void>>> = {}

const put = (path: string, content = '') =>
  store.set(path, { path, content, size: new TextEncoder().encode(content).length, updatedAt: T })

const transport = axios.create({
  adapter: async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const method = (config.method ?? 'get').toUpperCase()
    const url = axios.getUri(config)
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    calls.push({ method, url, body })
    const gate = gates[method]
    if (gate) await gate

    const respond = (status: number, data: unknown): AxiosResponse => {
      const response: AxiosResponse = {
        status,
        statusText: String(status),
        data,
        headers: { 'content-type': 'application/json' },
        config,
      }
      if (status >= 200 && status < 300) return response
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response)
    }

    const failure = failNext[method]
    if (failure) {
      delete failNext[method]
      return respond(failure.status, failure.data)
    }

    const parsed = new URL(url, 'http://localhost')
    if (parsed.pathname !== BASE) return respond(404, { error: `unexpected ${method} ${url}` })
    if (method === 'GET') {
      const files = [...store.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return respond(200, { files })
    }
    if (method === 'PUT') {
      const { path, content } = body as { path: string; content: string }
      put(path, content)
      return respond(200, store.get(path))
    }
    if (method === 'DELETE') {
      const path = parsed.searchParams.get('path') ?? ''
      if (!store.delete(path)) return respond(404, { error: 'Env file not found' })
      return respond(204, '')
    }
    return respond(405, { error: 'method not allowed' })
  },
})

const originalTransport = apiClient.getConfig().transport
beforeAll(() => {
  apiClient.setConfig({ transport })
})
afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
})

const mutations = () => calls.filter((c) => c.method !== 'GET')

// ── rendering ───────────────────────────────────────────────────────────────

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

/** React-reported problems (act warnings, render errors) fail the test. */
const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

let queryClient: QueryClient
let container: HTMLDivElement
let root: Root | null = null

const settle = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

async function mount() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={english}>
        <QueryClientProvider client={queryClient}>
          <Toaster />
          <EnvFilesPage projectId={PROJECT} />
        </QueryClientProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const buttons = (scope: ParentNode = container) => [...scope.querySelectorAll('button')]
const button = (label: string, scope: ParentNode = container) => {
  const found = buttons(scope).find((b) => text(b) === label)
  if (!found) throw new Error(`no "${label}" button; have: ${buttons(scope).map(text).join(' | ')}`)
  return found as HTMLButtonElement
}
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
const pathInput = () => container.querySelector('input') as HTMLInputElement
const cards = () => [...container.querySelectorAll('[data-slot="card"]')] as HTMLElement[]
const card = (path: string) => {
  const found = cards().find((c) => text(c.querySelector('[data-slot="card-title"]')) === path)
  if (!found) throw new Error(`no card for ${path}`)
  return found
}
const textarea = (path: string) => card(path).querySelector('textarea') as HTMLTextAreaElement
const saveButton = (path: string) => button('Save', card(path))
const groupHeadings = () => [...container.querySelectorAll('h2')].map(text)
const listedPaths = () => cards().map((c) => text(c.querySelector('[data-slot="card-title"]')))
const toasts = () => [...document.querySelectorAll('[data-slot="toast"]')].map(text)
const alertDialog = () => document.querySelector('[role="alertdialog"]')
const drawerPopup = () => document.querySelector('[data-slot="drawer-popup"]')

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => setValue(el, value))
  await settle(2)
}
const key = async (el: Element, init: KeyboardEventInit) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
  await settle()
}
const addPath = async (path: string) => {
  await type(pathInput(), path)
  await click(button('Add'))
}
/** The add field's own error (FieldError) — not a toast. */
const fieldError = () => text(container.querySelector('[data-slot="field-error"]')) || null

beforeEach(() => {
  store = new Map()
  calls = []
  failNext = {}
  gates = {}
  problems.length = 0
  document.body.innerHTML = ''
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  await act(async () => {
    toast.close()
  })
  document.body.innerHTML = ''
  queryClient?.clear()
})

// ── 2. header + how it works ────────────────────────────────────────────────

describe('header and "How it works" drawer', () => {
  test('shows the title, the inline explanation and a How it works button', async () => {
    await mount()
    expect(text(container.querySelector('h1'))).toBe('Env files')
    expect(text(container)).toContain(en.envFiles.lead)
    expect(button('How it works')).toBeTruthy()
    expect(drawerPopup()).toBeNull()
  })

  test('the drawer opens with the full guide and closes from its close button', async () => {
    await mount()
    await click(button('How it works'))
    const popup = drawerPopup()
    expect(popup).not.toBeNull()
    const guide = text(popup)
    const h = en.envFiles.howItWorks
    for (const s of [
      h.title,
      h.intro,
      h.layouts.rootOnly, // root `.env`
      h.layouts.serverWebapp, // server/.env + webapp/.env
      h.layouts.compose,
      h.rules.onCreateOnly,
      h.rules.branchWins,
      h.rules.keptOutOfGit,
      h.rules.allowedNames,
      h.storage.title,
      h.storage.location,
    ]) {
      expect(guide).toContain(s)
    }
    expect(guide).toContain('".env"')
    expect(guide).toContain('"server/.env"')
    expect(guide).toContain('"webapp/.env"')
    // The compose snippet, verbatim and as code.
    const code = popup?.querySelector('pre, code')
    expect(code?.textContent).toContain('env_file: ./server/.env')
    expect(popup?.textContent).toContain('services:')
    expect(popup?.getAttribute('data-swipe-direction')).toBe('right')

    await click(button('Close', popup as Element))
    await settle(20)
    expect(drawerPopup()).toBeNull()
    expect(problems).toEqual([])
  })

  test('Escape closes the drawer', async () => {
    await mount()
    await click(button('How it works'))
    expect(drawerPopup()).not.toBeNull()
    await key(document.activeElement ?? document.body, { key: 'Escape' })
    await settle(20)
    expect(drawerPopup()).toBeNull()
  })
})

// ── 3. loading / error / empty ──────────────────────────────────────────────

describe('loading, error and empty states', () => {
  test('a skeleton while the list is in flight, then the empty state', async () => {
    let release: () => void = () => {}
    gates.GET = new Promise<void>((r) => {
      release = r
    })
    await mount()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-slot="empty"]')).toBeNull()

    release()
    await settle()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0)
    const empty = container.querySelector('[data-slot="empty"]')
    expect(text(empty)).toContain(en.envFiles.empty.title)
    expect(calls).toEqual([{ method: 'GET', url: BASE, body: undefined }])
  })

  test('a failed load shows the server message in an alert, not an empty store', async () => {
    failNext.GET = { status: 404, data: { error: 'Project not found' } }
    await mount()
    const alert = container.querySelector('[role="alert"]')
    expect(text(alert)).toBe('Project not found')
    expect(container.querySelector('[data-slot="empty"]')).toBeNull()
    expect(cards()).toEqual([])
  })

  test('a load failure with no envelope falls back to a readable message', async () => {
    failNext.GET = { status: 500, data: 'oops' }
    await mount()
    // apiErrorMessage falls back to the Error's own message for a bodiless failure.
    expect(text(container.querySelector('[role="alert"]'))).toContain('500')
  })
})

// ── 4. listing ──────────────────────────────────────────────────────────────

describe('listing', () => {
  test('files grouped by folder, root group first, each card with path, meta and content', async () => {
    put('webapp/.env', 'VITE_API=/api\n')
    put('server/.env', 'PORT=3000\nDB=postgres\n')
    put('.env', 'A=1\n')
    put('.env.local', '')
    await mount()

    expect(groupHeadings()).toEqual(['/ (project root)', 'server/', 'webapp/'])
    expect(listedPaths()).toEqual(['.env', '.env.local', 'server/.env', 'webapp/.env'])
    expect(textarea('server/.env').value).toBe('PORT=3000\nDB=postgres\n')
    expect(textarea('.env.local').value).toBe('')
    expect(textarea('server/.env').getAttribute('aria-label')).toBe('Contents of server/.env')

    const meta = text(card('server/.env').querySelector('[data-slot="card-header"] p'))
    expect(meta.startsWith('22 B · updated ')).toBe(true)
    expect(meta.length).toBeGreaterThan('22 B · updated '.length)
    // The quick-add suggestions are for an empty store only.
    expect(buttons().map(text)).not.toContain('server/.env')
  })

  test('a card with an unparseable updatedAt shows just the size', async () => {
    store.set('.env', { path: '.env', content: 'x', size: 1, updatedAt: 'garbage' })
    await mount()
    expect(text(card('.env').querySelector('[data-slot="card-header"] p'))).toBe('1 B')
  })
})

// ── 5. add ──────────────────────────────────────────────────────────────────

describe('add form', () => {
  test.each([
    ['../.env', en.envFiles.validation.dotSegment],
    ['/x/.env', en.envFiles.validation.leadingSlash],
    ['a//.env', en.envFiles.validation.emptySegment],
    ['./.env', en.envFiles.validation.dotSegment],
    ['.git/.env', en.envFiles.validation.gitSegment],
    ['node_modules/.env', en.envFiles.validation.nodeModulesSegment],
    ['package.json', en.envFiles.validation.badBasename],
    ['server\\.env', en.envFiles.validation.backslash],
    ['server/', en.envFiles.validation.trailingSlash],
  ])('rejects %p client-side with its message and sends nothing', async (path, message) => {
    await mount()
    await addPath(path)
    expect(fieldError()).toBe(message)
    expect(pathInput().getAttribute('aria-invalid')).toBe('true')
    expect(mutations()).toEqual([])
  })

  test.each([['.env'], ['.env.local'], ['server/.env'], ['docker/db.env'], ['.devcontainer/.env']])(
    'accepts %p: PUTs it with empty content, clears the field, lists and focuses the new card',
    async (path) => {
      await mount()
      await addPath(path)
      expect(fieldError()).toBeNull()
      expect(mutations()).toEqual([{ method: 'PUT', url: BASE, body: { path, content: '' } }])
      expect(pathInput().value).toBe('')
      expect(listedPaths()).toEqual([path])
      expect(document.activeElement).toBe(textarea(path))
      expect(problems).toEqual([])
    },
  )

  test('Enter in the path field submits too', async () => {
    await mount()
    await type(pathInput(), 'server/.env')
    await key(pathInput(), { key: 'Enter' })
    expect(mutations()).toEqual([{ method: 'PUT', url: BASE, body: { path: 'server/.env', content: '' } }])
  })

  test('Add is disabled for an empty or whitespace-only path', async () => {
    await mount()
    expect(button('Add').disabled).toBe(true)
    await type(pathInput(), '   ')
    expect(button('Add').disabled).toBe(true)
    await key(pathInput(), { key: 'Enter' })
    expect(mutations()).toEqual([])
  })

  test('surrounding whitespace is trimmed before it is checked and sent', async () => {
    await mount()
    await addPath('  server/.env  ')
    expect(mutations()).toEqual([{ method: 'PUT', url: BASE, body: { path: 'server/.env', content: '' } }])
  })

  test('adding a path already listed sends no PUT, keeps its content, and focuses its card', async () => {
    put('.env', 'SECRET=keep-me\n')
    put('server/.env', 'PORT=1\n')
    await mount()
    expect(document.activeElement).not.toBe(textarea('server/.env'))

    await addPath('server/.env')
    expect(mutations()).toEqual([])
    expect(fieldError()).toBeNull()
    expect(pathInput().value).toBe('')
    expect(document.activeElement).toBe(textarea('server/.env'))
    expect(textarea('server/.env').value).toBe('PORT=1\n')
    expect(store.get('server/.env')?.content).toBe('PORT=1\n')
  })

  test('the duplicate check also covers a second attempt at the same path', async () => {
    put('.env', 'A=1')
    await mount()
    await addPath('.env')
    ;(document.activeElement as HTMLElement | null)?.blur()
    await addPath('.env')
    expect(mutations()).toEqual([])
    expect(document.activeElement).toBe(textarea('.env'))
  })

  test.each([
    [400, 'Filename must be ".env", ".env.<suffix>" or "<name>.env"'],
    [409, 'This project already has the maximum number of stored env files (100)'],
  ])('a server %p shows its message under the field and lists nothing', async (status, message) => {
    await mount()
    failNext.PUT = { status, data: { error: message } }
    await addPath('server/.env')
    expect(mutations()).toHaveLength(1)
    expect(fieldError()).toBe(message)
    expect(pathInput().value).toBe('server/.env') // kept, so the user can fix it
    expect(cards()).toEqual([])
  })

  test('a validation-issues envelope is shown issue by issue', async () => {
    await mount()
    failNext.PUT = {
      status: 400,
      data: { error: 'Invalid request', issues: [{ path: 'content', message: 'Too big' }] },
    }
    await addPath('.env')
    expect(fieldError()).toBe('content: Too big')
  })

  test('the empty-store quick-add buttons PUT their path', async () => {
    await mount()
    expect(text(container)).toContain(en.envFiles.add.suggestionsLabel)
    await click(button('server/.env'))
    expect(mutations()).toEqual([{ method: 'PUT', url: BASE, body: { path: 'server/.env', content: '' } }])
    expect(listedPaths()).toEqual(['server/.env'])
    // Gone once the store is no longer empty.
    expect(text(container)).not.toContain(en.envFiles.add.suggestionsLabel)
  })

  // The duplicate guard is only as good as the list it checks against. While
  // the list is still loading (or failed to load) `files` is `[]`, so a path
  // that *is* stored is not "already listed" and the add goes through as a
  // PUT with empty content — which the backend applies as an overwrite.
  test('quick-add while the list is still loading must not overwrite a stored file', async () => {
    put('.env', 'SECRET=keep-me\n')
    let release: () => void = () => {}
    gates.GET = new Promise<void>((r) => {
      release = r
    })
    await mount()
    const quick = buttons().find((b) => text(b) === '.env')
    // Either the button is not offered while loading, or using it does not
    // overwrite the stored file.
    if (quick && !quick.disabled) await click(quick)
    release()
    await settle()
    expect(store.get('.env')?.content).toBe('SECRET=keep-me\n')
    expect(mutations()).toEqual([])
  })

  test('adding a path while the list failed to load must not overwrite a stored file', async () => {
    put('.env', 'SECRET=keep-me\n')
    failNext.GET = { status: 500, data: { error: 'temporary failure' } }
    await mount()
    expect(text(container.querySelector('[role="alert"]'))).toBe('temporary failure')
    await type(pathInput(), '.env')
    // Either Add is not available while the list is unknown, or using it
    // does not overwrite the stored file.
    if (!button('Add').disabled) await click(button('Add'))
    expect(store.get('.env')?.content).toBe('SECRET=keep-me\n')
    expect(mutations()).toEqual([])
  })
})

// ── 6. save ─────────────────────────────────────────────────────────────────

describe('save', () => {
  test('Save is disabled until the draft differs from the saved content, and again when reverted', async () => {
    put('.env', 'A=1')
    await mount()
    expect(saveButton('.env').disabled).toBe(true)
    expect(text(card('.env'))).not.toContain(en.envFiles.card.unsaved)

    await type(textarea('.env'), 'A=2')
    expect(saveButton('.env').disabled).toBe(false)
    expect(text(card('.env'))).toContain(en.envFiles.card.unsaved)

    await type(textarea('.env'), 'A=1')
    expect(saveButton('.env').disabled).toBe(true)
    expect(text(card('.env'))).not.toContain(en.envFiles.card.unsaved)
  })

  test('clicking Save PUTs {path, content}, toasts success, and the card is clean afterwards', async () => {
    put('server/.env', 'PORT=1')
    await mount()
    await type(textarea('server/.env'), 'PORT=2\nHOST=0.0.0.0')
    await click(saveButton('server/.env'))

    expect(mutations()).toEqual([
      { method: 'PUT', url: BASE, body: { path: 'server/.env', content: 'PORT=2\nHOST=0.0.0.0' } },
    ])
    expect(toasts().join(' ')).toContain('Saved server/.env')
    expect(saveButton('server/.env').disabled).toBe(true)
    expect(textarea('server/.env').value).toBe('PORT=2\nHOST=0.0.0.0')
    // The refetch picked up the new size.
    expect(text(card('server/.env').querySelector('[data-slot="card-header"] p'))).toStartWith('19 B')
    expect(problems).toEqual([])
  })

  test('Ctrl+S inside the textarea saves; Cmd+S too', async () => {
    put('.env', 'A=1')
    put('b.env', 'B=1')
    await mount()
    await type(textarea('.env'), 'A=2')
    await key(textarea('.env'), { key: 's', ctrlKey: true })
    await type(textarea('b.env'), 'B=2')
    await key(textarea('b.env'), { key: 's', metaKey: true })
    expect(mutations()).toEqual([
      { method: 'PUT', url: BASE, body: { path: '.env', content: 'A=2' } },
      { method: 'PUT', url: BASE, body: { path: 'b.env', content: 'B=2' } },
    ])
  })

  // With Shift held (or Caps Lock on) the browser reports key 'S', not 's'.
  test('Ctrl+Shift+S and Cmd+S with Caps Lock (key "S") save too', async () => {
    put('.env', 'A=1')
    put('b.env', 'B=1')
    await mount()
    await type(textarea('.env'), 'A=2')
    await key(textarea('.env'), { key: 'S', ctrlKey: true, shiftKey: true })
    await type(textarea('b.env'), 'B=2')
    await key(textarea('b.env'), { key: 'S', metaKey: true })
    expect(mutations()).toEqual([
      { method: 'PUT', url: BASE, body: { path: '.env', content: 'A=2' } },
      { method: 'PUT', url: BASE, body: { path: 'b.env', content: 'B=2' } },
    ])
  })

  test('Ctrl+S with no changes sends nothing but still swallows the browser shortcut', async () => {
    put('.env', 'A=1')
    await mount()
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => {
      textarea('.env').dispatchEvent(event)
    })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(mutations()).toEqual([])
  })

  test('a plain "s" keystroke is not a save', async () => {
    put('.env', 'A=1')
    await mount()
    await type(textarea('.env'), 'A=2')
    await key(textarea('.env'), { key: 's' })
    expect(mutations()).toEqual([])
  })

  test('a double Ctrl+S while the first save is in flight sends one PUT', async () => {
    put('.env', 'A=1')
    await mount()
    await type(textarea('.env'), 'A=2')
    let release: () => void = () => {}
    gates.PUT = new Promise<void>((r) => {
      release = r
    })
    await key(textarea('.env'), { key: 's', ctrlKey: true })
    await key(textarea('.env'), { key: 's', ctrlKey: true })
    expect(saveButton('.env').disabled).toBe(true)
    release()
    await settle()
    expect(mutations()).toHaveLength(1)
  })

  test('a failed save toasts the server message and keeps the draft dirty', async () => {
    put('.env', 'A=1')
    await mount()
    await type(textarea('.env'), 'A=\u0000')
    failNext.PUT = { status: 400, data: { error: 'Content may not contain a NUL byte' } }
    await click(saveButton('.env'))
    expect(toasts().join(' ')).toContain('Content may not contain a NUL byte')
    expect(textarea('.env').value).toBe('A=\u0000')
    expect(saveButton('.env').disabled).toBe(false)
    expect(store.get('.env')?.content).toBe('A=1')
  })
})

// ── 7. drafts survive other files' refetch ──────────────────────────────────

test('an unsaved draft in file A survives the refetch after file B is saved', async () => {
  put('.env', 'A=1')
  put('server/.env', 'B=1')
  await mount()
  await type(textarea('.env'), 'A=draft')
  await type(textarea('server/.env'), 'B=2')
  await click(saveButton('server/.env'))

  // The list really was refetched after the save.
  expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET'])
  expect(textarea('.env').value).toBe('A=draft')
  expect(saveButton('.env').disabled).toBe(false)
  expect(text(card('.env'))).toContain(en.envFiles.card.unsaved)
  expect(saveButton('server/.env').disabled).toBe(true)
})

test('an unsaved draft survives another file being added (a new group appearing above it)', async () => {
  put('server/.env', 'B=1')
  await mount()
  await type(textarea('server/.env'), 'B=draft')
  await addPath('.env')
  expect(groupHeadings()).toEqual(['/ (project root)', 'server/'])
  expect(textarea('server/.env').value).toBe('B=draft')
})

// ── 8. delete ───────────────────────────────────────────────────────────────

describe('delete', () => {
  test('asks first; cancelling sends nothing and keeps the file', async () => {
    put('server/.env', 'X=1')
    await mount()
    await click(button('Delete', card('server/.env')))
    const dialog = alertDialog()
    expect(dialog).not.toBeNull()
    expect(text(dialog)).toContain(en.envFiles.card.deleteConfirmTitle)
    expect(text(dialog)).toContain('"server/.env"')

    await click(button('Cancel', dialog as Element))
    await settle(20)
    expect(alertDialog()).toBeNull()
    expect(mutations()).toEqual([])
    expect(listedPaths()).toEqual(['server/.env'])
  })

  test('confirming sends DELETE with ?path=, removes the card and toasts', async () => {
    put('.env', 'A=1')
    put('server/.env', 'X=1')
    await mount()
    await click(button('Delete', card('server/.env')))
    await click(button('Delete', alertDialog() as Element))
    await settle(20)

    expect(mutations()).toHaveLength(1)
    const del = mutations()[0] as Call
    expect(del.method).toBe('DELETE')
    const url = new URL(del.url, 'http://localhost')
    expect(url.pathname).toBe(BASE)
    expect(url.searchParams.get('path')).toBe('server/.env')
    expect(del.body).toBeUndefined()

    expect(listedPaths()).toEqual(['.env'])
    expect(groupHeadings()).toEqual(['/ (project root)'])
    expect(alertDialog()).toBeNull()
    expect(toasts().join(' ')).toContain('Deleted server/.env')
    expect(problems).toEqual([])
  })

  test('deleting the last file shows the empty state again', async () => {
    put('.env', 'A=1')
    await mount()
    await click(button('Delete', card('.env')))
    await click(button('Delete', alertDialog() as Element))
    await settle(20)
    expect(cards()).toEqual([])
    expect(text(container.querySelector('[data-slot="empty"]'))).toContain(en.envFiles.empty.title)
  })

  test('a failed delete toasts the server message, closes the dialog and keeps the file', async () => {
    put('.env', 'A=1')
    await mount()
    await click(button('Delete', card('.env')))
    failNext.DELETE = { status: 404, data: { error: 'Env file not found' } }
    await click(button('Delete', alertDialog() as Element))
    await settle(20)
    expect(toasts().join(' ')).toContain('Env file not found')
    expect(alertDialog()).toBeNull()
    expect(listedPaths()).toEqual(['.env'])
  })
})
