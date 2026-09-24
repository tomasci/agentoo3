// The two settings cases tests/workspace.test.tsx carried before the shadcn
// migration (see `git show HEAD:frontend/tests/workspace.test.tsx`) — moved
// here because SettingsPage now owns its own dedicated test file, the same
// as every other migrated feature's page.
//
// Mounted through the real router/shell, the same way workspace.test.tsx's
// own `mount()` does, rather than rendering `<SettingsPage/>` standalone:
// RootLayout is what actually applies the theme (the `dark` class on
// `<html>`, read off `themeAtom` in shared/store/ui.ts) —
// a bare render of the page could prove the select changed state, never that
// it changed the theme.
//
// Wrapped in its own, isolated `I18nextProvider` rather than relying on the
// app's ambient global i18next singleton (the one `@/shared/i18n` sets up):
// that singleton is a `bun test`-process-wide, unawaited side effect (see
// shared/i18n/index.ts) that whichever test file's render reaches first
// (this one, tests/storage-page.test.tsx, or any other file that happens to
// import the real router before either of them — several already do, e.g.
// tests/idea-board-page.test.tsx) initialises for every *other* file
// afterwards too, permanently, for the rest of the run. tests/storage-
// page.test.tsx depends on `t()` returning a raw key (see its own header
// comment); this file's own "settings.themeLight" match below depends on the
// exact same thing. Rather than racing every other file in the suite for who
// gets to decide that, this instance is a private `cimode` one — i18next's
// own always-return-the-key mode — that only this file's render ever sees.
//
// Deliberately never `.use(initReactI18next)`: that plugin's `init()` sets
// react-i18next's own *module-level* default instance — the one every
// `useTranslation()` with no `I18nextProvider` above it falls back to — and
// it does that for whichever instance calls it, not just the app's real one.
// Calling it here would silently swap that global default to this file's
// inert `cimode` instance for the rest of the run, breaking real translations
// in every later file that renders without a provider of its own (verified:
// that is exactly what broke tests/workspace.test.tsx while this comment was
// being written). `I18nextProvider` below needs no plugin on the instance it
// wraps — it hands it to `useTranslation()` through context directly.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import i18next from 'i18next'
import { Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { routeTree } from '../src/app/router'

const testI18n = i18next.createInstance()
await testI18n.init({ lng: 'cimode', fallbackLng: 'cimode' })

const project = (id: string, name: string) => ({
  id, name, slug: name.toLowerCase(), source: 'clone', remoteUrl: null, sourceName: null,
  sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null, recoveryCommands: null,
  path: `/srv/${name.toLowerCase()}`, createdAt: '', updatedAt: '',
})
const PROJECTS = [project('p1', 'Alpha')]

let container: HTMLDivElement
let router: ReturnType<typeof createRouter>
let client: QueryClient
let root: Root

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)

  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  // Seeded, so the shell never reaches for a backend — same fixtures as
  // workspace.test.tsx's own `mount()`.
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  for (const p of PROJECTS) {
    client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: p.id } }], [])
  }

  root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={testI18n}>
        <JotaiProvider>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </JotaiProvider>
      </I18nextProvider>,
    )
  })
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/**
 * A printable stand-in for an element, wrapped around every operand of a
 * matcher that prints its operands on failure (`toBeNull`/`not.toBeNull`) —
 * see tests/workspace.test.tsx's own copy of this helper for the OOM a bare
 * happy-dom element triggers on a failed assertion.
 */
const tokens = new WeakMap<Node, string>()
let tokenCount = 0
function ref(node: Node | null | undefined): string | null | undefined {
  if (node === null || node === undefined) return node
  const seen = tokens.get(node)
  if (seen) return seen
  const el = node as Element
  const named = el.getAttribute?.('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
  const token = `<${node.nodeName.toLowerCase()} #${++tokenCount}${named ? ` ${JSON.stringify(named)}` : ''}>`
  tokens.set(node, token)
  return token
}

const click = async (el: Element | null | undefined, what = 'element') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  client.clear()
})

test('configuration holds the language and the theme, and only the system tab has it', async () => {
  await mount('/settings')
  expect(ref(container.querySelector('#settings-language'))).not.toBeNull()
  expect(ref(container.querySelector('#settings-theme'))).not.toBeNull()

  // The old shell kept these as a native select and an icon toggle in every
  // sidebar; now the only place either control exists is this page.
  await act(async () => {
    root.unmount()
  })
  container.remove()
  await mount('/projects/p1')
  expect(ref(container.querySelector('#settings-theme'))).toBeNull()
  expect(ref(container.querySelector('#settings-language'))).toBeNull()
  expect(ref(container.querySelector('[aria-label="Toggle theme"]'))).toBeNull()
})

test('the theme selector actually changes the theme', async () => {
  await mount('/settings')
  expect(document.documentElement.classList.contains('dark')).toBe(true)

  // A plain click both opens the popup and (on the option) selects it — no
  // native <select> and no `change` event the way the old test drove this.
  // Matched on the raw key, not the translated word — see this file's own
  // header comment on why `t()` returns one here.
  await click(container.querySelector('#settings-theme'), 'theme select trigger')
  const option = [...document.body.querySelectorAll('[role="option"]')].find(
    (el) => el.textContent === 'settings.themeLight',
  )
  await click(option, 'settings.themeLight option')

  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(localStorage.getItem('agentoo:theme')).toContain('light')
})
