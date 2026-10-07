// GitIdentityCard edges tests/git-identity-card.test.tsx does not reach: a
// 409 from Save (locked config / project not ready) surfaced in the card, a
// 400 carrying field `issues`, Save and Clear both disabled while a PUT is in
// flight (and a second click sending nothing), an email-only local prefill
// that keeps Save disabled until the name is filled in, Save going disabled
// again once a save lands, a stale server error cleared by the next save, a
// load failure showing no form, and the client schema refusing the same C1
// control characters the backend refuses.
//
// Same harness as git-identity-card.test.tsx: the real router at
// /projects/p1/settings, ambient queries seeded, and the three generated
// git-identity clients replaced through tests/mock-module.ts.

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

type Identity = { name: string | null; email: string | null }
type GitIdentityState = {
  available: boolean
  configPath: string | null
  local: Identity
  effective: Identity
}

const BASE: GitIdentityState = {
  available: true,
  configPath: '/srv/alpha/.git/config',
  local: { name: null, email: null },
  effective: { name: null, email: null },
}

let state: GitIdentityState = BASE
let getFailure: unknown = null
let putCalls: { name: string; email: string }[] = []
let deleteCalls = 0
/** Each PUT shifts one entry: an error to throw, 'hang' to wait on `release`,
 *  or undefined to succeed immediately. */
let putPlan: unknown[] = []
let release: (() => void) | null = null

await mockModule('@/shared/api/generated/clients/getProjectGitIdentity', () => ({
  getProjectGitIdentity: async () => {
    if (getFailure) throw getFailure
    return { data: state }
  },
}))
await mockModule('@/shared/api/generated/clients/putProjectGitIdentity', () => ({
  putProjectGitIdentity: async (opts: { body: { name: string; email: string } }) => {
    putCalls.push(opts.body)
    const step = putPlan.shift()
    if (step === 'hang') await new Promise<void>((r) => (release = r))
    else if (step) throw step
    state = {
      ...state,
      local: { ...opts.body },
      effective: { ...opts.body },
    }
    return { data: state }
  },
}))
await mockModule('@/shared/api/generated/clients/deleteProjectGitIdentity', () => ({
  deleteProjectGitIdentity: async () => {
    deleteCalls++
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

const ALPHA = {
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  source: 'clone',
  remoteUrl: 'git@github.com:acme/alpha.git',
  sourceName: null,
  sshKeyId: null,
  defaultBranch: 'main',
  status: 'ready',
  lastError: null,
  recoveryCommands: null,
  path: '/srv/alpha',
  createdAt: '',
  updatedAt: '',
}

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
  client.setQueryData([{ url: '/api/projects' }], [ALPHA])
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/whats-new' }], {
    installedVersion: null,
    installedAt: null,
    pending: false,
  })
  client.setQueryData([{ url: '/api/notifications' }], {
    items: [],
    hasUnread: false,
    truncated: false,
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/sessions/overview' }, { window: '1d' }], {
    running: [],
    unchecked: [],
    recent: [],
    window: '1d',
  })
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

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  problems.length = 0
  state = BASE
  getFailure = null
  putCalls = []
  deleteCalls = 0
  putPlan = []
  release = null
})

afterEach(async () => {
  release?.()
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  client?.clear()
  toast.close()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const card = (): HTMLElement => {
  const title = [...container.querySelectorAll('[data-slot="card-title"]')].find(
    (el) => text(el) === 'Git identity',
  )
  const found = title?.closest('[data-slot="card"]') as HTMLElement | null | undefined
  if (!found) throw new Error('no "Git identity" card on the page')
  return found
}
const field = (label: string): HTMLInputElement => {
  const found = [...card().querySelectorAll('label')].find((el) => text(el) === label)
  const id = found?.getAttribute('for')
  const input = id ? (card().querySelector(`#${id}`) as HTMLInputElement | null) : null
  if (!input) throw new Error(`no input labelled "${label}" in the card`)
  return input
}
const fieldErrorFor = (label: string): Element | null => {
  const found = [...card().querySelectorAll('label')].find((el) => text(el) === label)
  return found?.closest('[data-slot="field"]')?.querySelector('[data-slot="field-error"]') ?? null
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
const destructiveAlertTexts = () =>
  [...card().querySelectorAll('[data-slot="alert"]')]
    .filter((el) => el.className.includes('text-destructive'))
    .map((el) => text(el))
const toastTitles = () =>
  [...document.body.querySelectorAll('[data-slot="toast-title"]')].map((el) => text(el))

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

const MISSING =
  'No git identity is configured. Commits made by agents in this project will fail until one is set.'

test('a 409 from Save shows the lock message in the card, keeps the input, and Save stays usable for a retry', async () => {
  putPlan = [httpError(409, { error: 'The repository config is locked by another process; try again' })]
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'grace@example.com')
  await click(requireButton('Save'))

  expect(putCalls).toHaveLength(1)
  expect(destructiveAlertTexts()).toContain(
    'The repository config is locked by another process; try again',
  )
  expect(toastTitles()).not.toContain('Saved')
  expect(field('Name').value).toBe('Grace Hopper')
  expect(field('Email').value).toBe('grace@example.com')
  expect(requireButton('Save').disabled).toBe(false)

  // The retry succeeds and the stale error goes away with it.
  await click(requireButton('Save'))
  expect(putCalls).toHaveLength(2)
  expect(toastTitles()).toContain('Saved')
  expect(destructiveAlertTexts()).not.toContain(
    'The repository config is locked by another process; try again',
  )
  expect(text(card())).toContain('Commits are authored as Grace Hopper <grace@example.com>.')
})

test('a 409 "not ready" from Save shows that message, not the generic fallback', async () => {
  putPlan = [httpError(409, { error: 'This project has no repository to set a git identity on right now' })]
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'grace@example.com')
  await click(requireButton('Save'))

  expect(destructiveAlertTexts()).toContain(
    'This project has no repository to set a git identity on right now',
  )
  expect(destructiveAlertTexts()).not.toContain('Could not save the git identity')
})

test('a validation 400 with issues shows the field-level detail', async () => {
  putPlan = [
    httpError(400, {
      error: 'Validation failed',
      issues: [{ path: 'name', message: 'Name may not contain control characters' }],
    }),
  ]
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'grace@example.com')
  await click(requireButton('Save'))

  expect(destructiveAlertTexts()).toContain('name: Name may not contain control characters')
})

test('a network failure with no response body falls back to the error message', async () => {
  putPlan = [new AxiosError('Network Error', AxiosError.ERR_NETWORK)]
  await mount()
  await type(field('Name'), 'Grace Hopper')
  await type(field('Email'), 'grace@example.com')
  await click(requireButton('Save'))

  expect(destructiveAlertTexts()).toContain('Network Error')
})

test('while a PUT is in flight Save and Clear are both disabled, and a second click sends nothing', async () => {
  state = {
    ...BASE,
    local: { name: 'Ada Lovelace', email: 'ada@example.com' },
    effective: { name: 'Ada Lovelace', email: 'ada@example.com' },
  }
  putPlan = ['hang']
  await mount()
  await type(field('Name'), 'Ada King')
  await click(requireButton('Save'))

  expect(putCalls).toHaveLength(1)
  expect(requireButton('Save').disabled).toBe(true)
  expect(requireButton('Clear').disabled).toBe(true)
  await click(requireButton('Save'))
  await click(requireButton('Clear'))
  expect(putCalls).toHaveLength(1)
  expect(deleteCalls).toBe(0)

  await act(async () => {
    release?.()
  })
  await settle()
  expect(text(card())).toContain('Commits are authored as Ada King <ada@example.com>.')
  // Saved values now match the form again: nothing left to save.
  expect(requireButton('Save').disabled).toBe(true)
  expect(requireButton('Clear').disabled).toBe(false)
})

test('an email-only local prefills the email, warns, and keeps Save disabled until a name is entered', async () => {
  state = {
    ...BASE,
    local: { name: null, email: 'only@example.com' },
    effective: { name: null, email: 'only@example.com' },
  }
  await mount()

  expect(field('Name').value).toBe('')
  expect(field('Email').value).toBe('only@example.com')
  expect(destructiveAlertTexts()).toContain(MISSING)
  expect(button('Clear')).not.toBeUndefined()
  expect(requireButton('Save').disabled).toBe(true)

  await type(field('Name'), 'Only Name')
  expect(requireButton('Save').disabled).toBe(false)
  await click(requireButton('Save'))
  expect(putCalls).toEqual([{ name: 'Only Name', email: 'only@example.com' }])
})

test('local unset but effective set: the server-wide note, no warning, no Clear, empty fields', async () => {
  state = { ...BASE, effective: { name: 'Server Wide', email: 'server@example.com' } }
  await mount()

  expect(text(card())).toContain(
    'Nothing is set for this project. Commits currently use the server-wide identity Server Wide <server@example.com>.',
  )
  expect(destructiveAlertTexts()).toEqual([])
  expect(button('Clear')).toBeUndefined()
  expect(field('Name').value).toBe('')
  expect(field('Email').value).toBe('')
  expect(requireButton('Save').disabled).toBe(true)
})

test('the config path is shown so the operator can edit it by hand', async () => {
  state = { ...BASE, configPath: '/home/op/code/real-repo/.git/config' }
  await mount()
  expect(text(card())).toContain('Editing this file by hand has the same effect:')
  expect([...card().querySelectorAll('code')].map((el) => text(el))).toContain(
    '/home/op/code/real-repo/.git/config',
  )
})

test('a failed GET shows the server message and no form', async () => {
  getFailure = httpError(500, { error: 'Internal server error' })
  await mount()

  expect(destructiveAlertTexts()).toContain('Internal server error')
  expect(card().querySelector('form')).toBeNull()
  expect(card().querySelector('input')).toBeNull()
})

for (const [label, value] of [
  ['a C1 control character (U+0085)', 'Ada\u0085King'],
  ['a C1 control character (U+009B, CSI)', 'Ada\u009bKing'],
  ['a "<"', 'Ada <King'],
  ['a leading "-"', '-Ada'],
] as const) {
  test(`a name containing ${label} is refused inline, like the backend refuses it, and sends no PUT`, async () => {
    await mount()
    await type(field('Name'), value)
    await type(field('Email'), 'ada@example.com')
    // An <input> strips CR/LF from its value, so a newline can never reach
    // the schema from this field; every case here must survive that.
    expect(field('Name').value).toBe(value)

    expect(text(fieldErrorFor('Name'))).toBe(
      'Name may not contain control characters, "<" or ">", or start with "-"',
    )
    expect(requireButton('Save').disabled).toBe(true)
    await click(requireButton('Save'))
    expect(putCalls).toEqual([])
  })
}

test('a 201-character name is refused inline as too long', async () => {
  await mount()
  await type(field('Name'), 'n'.repeat(201))
  await type(field('Email'), 'ada@example.com')
  expect(text(fieldErrorFor('Name'))).toBe('Name is too long')
  expect(requireButton('Save').disabled).toBe(true)
})

test('a GitHub noreply email is accepted by the form', async () => {
  await mount()
  await type(field('Name'), 'Someone')
  await type(field('Email'), '123456+someone@users.noreply.github.com')
  expect(fieldErrorFor('Email')).toBeNull()
  expect(requireButton('Save').disabled).toBe(false)
  await click(requireButton('Save'))
  expect(putCalls).toEqual([{ name: 'Someone', email: '123456+someone@users.noreply.github.com' }])
  expect(problems).toEqual([])
})
