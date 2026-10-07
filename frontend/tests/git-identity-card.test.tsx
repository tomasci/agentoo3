// The project Settings page's "Git identity" card (GitIdentityCard, rendered
// by project-overview.tsx right after Authentication): the four status
// lines derived from `local`/`effective` (including a partially-set `local`
// — one field only, as a hand edit of .git/config could leave it — which
// counts as "not fully set" for the status line but still pre-fills whatever
// is there, and is called out with its own note distinct from the fully-
// unset case whenever `effective` is complete, since part of what's
// effective is then this project's own), the muted no-form note when
// `available: false`, a Save that sends the *trimmed* values and only once
// the form actually differs from what loaded, a server 400 surfaced in a
// destructive alert inside the card, and Clear sending a DELETE and
// re-seeding the form from its response.
//
// Mounted through the real router/shell at `/projects/p1/settings`, seeding
// the project list query directly the way tests/project-settings-nav.test.tsx
// does for the identical route, with the three generated git-identity
// clients replaced through tests/mock-module.ts as a tiny stateful fake
// server — a PUT/DELETE really changes what the next GET (and the mutation's
// own response) answers — the same idiom tests/session-limit-card.test.tsx
// uses for its PATCH.
//
// Wrapped in a private English `I18nextProvider`, the way tests/session-
// limit-card.test.tsx builds its own, because the wording itself is part of
// what is being checked. `<Toaster />` is rendered alongside the router
// because the app mounts it in providers.tsx, outside the route tree — the
// same arrangement that file's header comment describes.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import en from '../src/shared/i18n/locales/en.json'
import { mockModule } from './mock-module'

const GET_CLIENT = '@/shared/api/generated/clients/getProjectGitIdentity'
const PUT_CLIENT = '@/shared/api/generated/clients/putProjectGitIdentity'
const DELETE_CLIENT = '@/shared/api/generated/clients/deleteProjectGitIdentity'

type Identity = { name: string | null; email: string | null }
type GitIdentityState = {
  available: boolean
  configPath: string | null
  local: Identity
  effective: Identity
}

const AVAILABLE_FIXTURE: GitIdentityState = {
  available: true,
  configPath: '/srv/alpha/.git/config',
  local: { name: null, email: null },
  effective: { name: null, email: null },
}

/** The fake server's own state: what the next GET answers is derived from it,
 *  and a PUT/DELETE really changes it, the same as `current()` in
 *  session-limit-card.test.tsx. */
let state: GitIdentityState = AVAILABLE_FIXTURE
let getCalls = 0
let putCalls: { name: string; email: string }[] = []
let deleteCalls = 0
/** When set, the PUT/DELETE rejects with it (and `state` is unchanged). */
let putFailure: unknown = null
let deleteFailure: unknown = null

await mockModule(GET_CLIENT, () => ({
  getProjectGitIdentity: async () => {
    getCalls++
    return { data: state }
  },
}))
await mockModule(PUT_CLIENT, () => ({
  putProjectGitIdentity: async (opts: { body: { name: string; email: string } }) => {
    putCalls.push(opts.body)
    if (putFailure) throw putFailure
    state = { ...state, local: { name: opts.body.name, email: opts.body.email } }
    return { data: state }
  },
}))
await mockModule(DELETE_CLIENT, () => ({
  deleteProjectGitIdentity: async () => {
    deleteCalls++
    if (deleteFailure) throw deleteFailure
    state = { ...state, local: { name: null, email: null } }
    return { data: state }
  },
}))

const { routeTree } = await import('../src/app/router')
const { Toaster, toast } = await import('../src/shared/ui/toast')

const english = i18next.createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

/** A real axios error carrying a response body, the way the generated client
 *  throws one under `throwOnError` for a non-2xx answer — same helper as
 *  tests/session-limit-card.test.tsx's own. */
function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() }
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    { status, statusText: '', data, headers: {}, config },
  )
}

const project = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  source: 'clone',
  remoteUrl: `git@github.com:acme/${name.toLowerCase()}.git`,
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`,
  createdAt: '',
  updatedAt: '',
})
const ALPHA = project('p1', 'Alpha')

const problems: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => String(a)).join(' ').slice(0, 300))
  realError(...args)
}
afterAll(() => {
  console.error = realError
})

let container: HTMLDivElement
let root: Root | null = null
let client: QueryClient

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/settings'] }),
  })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // The shell's own ambient queries, seeded the same way tests/project-
  // settings-nav.test.tsx seeds them for this identical route — nothing
  // here has anything of its own to say about any of them.
  client.setQueryData([{ url: '/api/projects' }], [ALPHA])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData(
    [{ url: '/api/whats-new' }],
    { installedVersion: null, installedAt: null, pending: false },
  )
  client.setQueryData(
    [{ url: '/api/notifications' }],
    { items: [], hasUnread: false, truncated: false },
  )
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData(
    [{ url: '/api/sessions/overview' }, { window: '1d' }],
    { running: [], unchecked: [], recent: [], window: '1d' },
  )
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={english}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <Toaster />
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  state = AVAILABLE_FIXTURE
  getCalls = 0
  putCalls = []
  deleteCalls = 0
  putFailure = null
  deleteFailure = null
})

afterEach(async () => {
  await unmount()
  toast.close()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** The card whose title is "Git identity". */
const card = (): HTMLElement => {
  const title = [...container.querySelectorAll('[data-slot="card-title"]')].find(
    (el) => text(el) === 'Git identity',
  )
  const found = title?.closest('[data-slot="card"]') as HTMLElement | null | undefined
  if (!found) throw new Error('no "Git identity" card on the page')
  return found
}
/** The input the given label points at, inside the card. */
const field = (label: string): HTMLInputElement => {
  const found = [...card().querySelectorAll('label')].find((el) => text(el) === label)
  const id = found?.getAttribute('for')
  const input = id ? (card().querySelector(`#${id}`) as HTMLInputElement | null) : null
  if (!input) throw new Error(`no input labelled "${label}" in the card`)
  return input
}
/** The field error beneath the given label, or null if there is none. */
const fieldErrorFor = (label: string): Element | null => {
  const found = [...card().querySelectorAll('label')].find((el) => text(el) === label)
  const fieldEl = found?.closest('[data-slot="field"]')
  return fieldEl?.querySelector('[data-slot="field-error"]') ?? null
}
const button = (label: string): HTMLButtonElement | undefined =>
  [...card().querySelectorAll('button')].find((b) => text(b) === label) as
    | HTMLButtonElement
    | undefined
const requireButton = (label: string): HTMLButtonElement => {
  const found = button(label)
  if (!found) throw new Error(`no "${label}" button in the card`)
  return found
}
const destructiveAlerts = (scope: Element) =>
  [...scope.querySelectorAll('[data-slot="alert"]')].filter((el) =>
    el.className.includes('text-destructive'),
  )
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))

/** Types into a controlled input the way a browser does — see
 *  tests/session-limit-card.test.tsx's identical helper. */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter to type through')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
  await settle()
}

// 1. The four status lines, including a partially-set local -------------

test('a fully-set local identity shows "Commits are authored as …"', async () => {
  state = {
    ...AVAILABLE_FIXTURE,
    local: { name: 'Ada Lovelace', email: 'ada@example.com' },
    effective: { name: 'Ada Lovelace', email: 'ada@example.com' },
  }
  await mount()

  expect(text(card())).toContain('Commits are authored as Ada Lovelace <ada@example.com>.')
  expect(field('Name').value).toBe('Ada Lovelace')
  expect(field('Email').value).toBe('ada@example.com')
  expect(button('Clear')).not.toBeUndefined()
  expect(destructiveAlerts(card())).toHaveLength(0)
  expect(problems).toEqual([])
})

test('a partially-set local (one field only) counts as not fully set: prefills what exists and shows the partial-identity note', async () => {
  // Realistic, unlike a mismatched fixture would be: `local.name` is set, and
  // a locally-set key always appears identically in `effective` (it overrides
  // global per key, per the backend's own `GitIdentityState` doc comment) —
  // only `email`, left unset locally, actually falls back to the server-wide
  // config here.
  state = {
    ...AVAILABLE_FIXTURE,
    local: { name: 'Hand Edited', email: null },
    effective: { name: 'Hand Edited', email: 'server@example.com' },
  }
  await mount()

  expect(text(card())).toContain(
    'Commits are authored as Hand Edited <server@example.com>, part of it from the server-wide git config.',
  )
  expect(text(card())).not.toContain('Nothing is set for this project')
  expect(field('Name').value).toBe('Hand Edited')
  expect(field('Email').value).toBe('')
  // `local.name` alone is still non-empty, so Clear is offered.
  expect(button('Clear')).not.toBeUndefined()
})

test('local fully unset with a complete effective identity shows the server-wide note, not the partial one', async () => {
  state = { ...AVAILABLE_FIXTURE, effective: { name: 'Server Wide', email: 'server@example.com' } }
  await mount()

  expect(text(card())).toContain(
    'Nothing is set for this project. Commits currently use the server-wide identity Server Wide <server@example.com>.',
  )
  expect(text(card())).not.toContain('part of it from the server-wide git config')
  expect(button('Clear')).toBeUndefined()
})

test('completing the missing field for a partially-set local replaces the partial note with the fully-set one', async () => {
  state = {
    ...AVAILABLE_FIXTURE,
    local: { name: 'Hand Edited', email: null },
    effective: { name: 'Hand Edited', email: 'server@example.com' },
  }
  await mount()

  await type(field('Email'), 'hand@example.com')
  await click(requireButton('Save'))

  expect(putCalls).toEqual([{ name: 'Hand Edited', email: 'hand@example.com' }])
  expect(text(card())).toContain('Commits are authored as Hand Edited <hand@example.com>.')
  expect(text(card())).not.toContain('part of it from the server-wide git config')
})

test('neither local nor effective set shows a warning that commits will fail', async () => {
  state = { ...AVAILABLE_FIXTURE, local: { name: null, email: null }, effective: { name: null, email: null } }
  await mount()

  const alerts = destructiveAlerts(card())
  expect(alerts.map((a) => text(a))).toContain(
    'No git identity is configured. Commits made by agents in this project will fail until one is set.',
  )
  expect(button('Clear')).toBeUndefined()
})

// 2. Unavailable --------------------------------------------------------

test('available: false shows a muted note and no form', async () => {
  state = { available: false, configPath: null, local: { name: null, email: null }, effective: { name: null, email: null } }
  await mount()

  expect(text(card())).toContain(
    'Not available yet — this can be set once the project finishes setting up.',
  )
  expect(card().querySelector('input')).toBeNull()
  expect(card().querySelector('form')).toBeNull()
  expect(problems).toEqual([])
})

// 3. Save -----------------------------------------------------------------

test('Save sends the trimmed values, toasts, and the fields keep the trimmed result', async () => {
  await mount()
  expect(getCalls).toBe(1)
  await type(field('Name'), '  Grace Hopper  ')
  await type(field('Email'), '  grace@example.com  ')
  await click(requireButton('Save'))

  expect(putCalls).toEqual([{ name: 'Grace Hopper', email: 'grace@example.com' }])
  expect(toastTitles()).toContain('Saved')
  expect(field('Name').value).toBe('Grace Hopper')
  expect(field('Email').value).toBe('grace@example.com')
  expect(text(card())).toContain('Commits are authored as Grace Hopper <grace@example.com>.')
  expect(destructiveAlerts(card())).toHaveLength(0)
  expect(problems).toEqual([])
})

test('Save is disabled until the form actually differs from what loaded', async () => {
  state = { ...AVAILABLE_FIXTURE, local: { name: 'Ada Lovelace', email: 'ada@example.com' } }
  await mount()
  expect(requireButton('Save').disabled).toBe(true)

  await type(field('Name'), 'Ada Lovelace Edited')
  expect(requireButton('Save').disabled).toBe(false)

  await type(field('Name'), 'Ada Lovelace')
  expect(requireButton('Save').disabled).toBe(true)
  expect(putCalls).toEqual([])
})

test('an invalid email keeps Save disabled and shows the inline error, sending no PUT', async () => {
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'not-an-email')

  expect(text(fieldErrorFor('Email'))).toBe('Enter a valid email address')
  expect(requireButton('Save').disabled).toBe(true)
  await click(requireButton('Save'))
  expect(putCalls).toEqual([])
})

test("a 400 from PUT shows the server's message in a destructive alert inside the card", async () => {
  // Valid by the client's own schema — this is a server-side rejection
  // (a race, or a rule the server enforces more strictly), not the
  // client-side one `fieldErrorFor` already covers.
  putFailure = httpError(400, { error: 'email looks like a no-reply address the host will bounce' })
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'grace@example.com')
  await click(requireButton('Save'))

  expect(putCalls).toHaveLength(1)
  expect(destructiveAlerts(card()).map((a) => text(a))).toContain(
    'email looks like a no-reply address the host will bounce',
  )
  expect(toastTitles()).not.toContain('Saved')
  // The typed values are kept for the reader to fix, nothing was saved.
  expect(field('Name').value).toBe('Grace Hopper')
  expect(field('Email').value).toBe('grace@example.com')
})

// 4. Clear ------------------------------------------------------------------

test('Clear sends a DELETE, toasts, and re-seeds the form from its response', async () => {
  state = {
    ...AVAILABLE_FIXTURE,
    local: { name: 'Ada Lovelace', email: 'ada@example.com' },
    effective: { name: 'Ada Lovelace', email: 'ada@example.com' },
  }
  await mount()
  await click(requireButton('Clear'))

  expect(deleteCalls).toBe(1)
  expect(toastTitles()).toContain('Cleared')
  expect(field('Name').value).toBe('')
  expect(field('Email').value).toBe('')
  expect(button('Clear')).toBeUndefined()
  // `effective` still names the same person (nothing cleared that), so this
  // falls back to the "using the server-wide identity" note, not the warning.
  expect(text(card())).toContain(
    'Nothing is set for this project. Commits currently use the server-wide identity Ada Lovelace <ada@example.com>.',
  )
  expect(destructiveAlerts(card())).toHaveLength(0)
  expect(problems).toEqual([])
})

test('a failed Clear leaves the local identity in place and shows the server message', async () => {
  state = { ...AVAILABLE_FIXTURE, local: { name: 'Ada Lovelace', email: 'ada@example.com' } }
  deleteFailure = httpError(409, { error: 'config is locked, try again' })
  await mount()
  await click(requireButton('Clear'))

  expect(deleteCalls).toBe(1)
  expect(destructiveAlerts(card()).map((a) => text(a))).toContain('config is locked, try again')
  expect(field('Name').value).toBe('Ada Lovelace')
  expect(button('Clear')).not.toBeUndefined()
})
