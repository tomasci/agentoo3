// The custom background in the real shell (src/app/root-layout.tsx `Shell`,
// src/app/sidebar.tsx `ShellSidebar`, features/appearance's
// `BackgroundBackdrop`), mounted through the real router the way
// tests/shell.test.tsx does.
//
// The contract, both ways round:
// - off (both 'none' — the default, an explicit 'none', or anything in storage
//   that isn't a known id): no backdrop element, no glass on the inset, no
//   transparency on the sidebar — the wrapper's children are exactly the top
//   bar, the row and the status bar, as tests/shell.test.tsx pins them;
// - on (a colour, a gradient, a pattern, or both): exactly one aria-hidden,
//   pointer-events-none backdrop inside `[data-slot=sidebar-wrapper]` carrying
//   the catalog's classes for the chosen colour and an SVG pattern when one is
//   chosen; the inset gains `bg-background/70 backdrop-blur-xl ring-1
//   ring-border/50`; the desktop sidebar container gains
//   `*:data-[slot=sidebar-inner]:bg-transparent`;
// - and it follows the atoms live: a write here, a write from another tab
//   (valid or garbage), and back to none again.
//
// Class names are the only observable for these decisions in happy-dom (no
// Tailwind CSS is loaded, nothing is laid out), so they are asserted as such.
//
// Hermetic the same way tests/shell.test.tsx is: empty <body>, cleared
// localStorage, an offline API transport, an inert EventSource.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import { BACKGROUND_CLASS_NAME } from '../src/features/appearance/lib/catalog'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { backgroundAtom, backgroundPatternAtom } from '../src/shared/store/ui'

const BG_KEY = 'agentoo:background'
const PATTERN_KEY = 'agentoo:background-pattern'

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const

const GLASS = ['bg-background/70', 'backdrop-blur-xl', 'ring-1', 'ring-border/50'] as const
const TRANSPARENT_SIDEBAR = '*:data-[slot=sidebar-inner]:bg-transparent'
/** Every class token any catalog background uses. */
const ALL_CATALOG_TOKENS = new Set(
  Object.values(BACKGROUND_CLASS_NAME).flatMap((c) => c.split(/\s+/).filter(Boolean)),
)

const PROJECTS = [
  {
    id: 'p1', name: 'Alpha', slug: 'alpha', source: 'clone', remoteUrl: null, sourceName: null,
    sshKeyId: null, defaultBranch: 'main', status: 'ready', lastError: null,
    recoveryCommands: null, path: '/srv/alpha', createdAt: '', updatedAt: '',
  },
]

const offlineTransport = (() =>
  ({
    request: async () => {
      throw new Error('ECONNREFUSED (no backend in a unit test)')
    },
  }) as unknown as AxiosInstance)()
const originalTransport = apiClient.getConfig().transport

class InertEventSource {
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = InertEventSource

let container: HTMLDivElement
let root: Root | undefined
let store: ReturnType<typeof createStore>
const errors: string[] = []
const realConsoleError = console.error

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData([{ url: '/api/projects' }], PROJECTS)
  client.setQueryData([{ url: '/api/ssh-keys' }], [])
  client.setQueryData([{ url: '/api/health' }], { claudeCredential: true, version: '0.1.41' })
  client.setQueryData([{ url: '/api/system' }], {
    cpu: { usagePercent: 10, cores: 4, load1: 0.5 },
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 20 },
    disk: { usedBytes: 1, totalBytes: 2, usedPercent: 30, path: '/' },
  })
  client.setQueryData([{ url: '/api/docker/detection' }], { enabled: true, projects: [] })
  client.setQueryData([{ url: '/api/projects/:id/sessions', params: { id: 'p1' } }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'pending' }], [])
  client.setQueryData([{ url: '/api/library/suggestions' }, { status: 'rejected' }], [])
  client.setQueryData(
    [{ url: '/api/system/prompts/:name', params: { name: 'session-learning' } }],
    { name: 'session-learning', body: 'x', path: '/x.md', source: 'default' },
  )
  // The status bar's version button and the "what's new" screen
  // (app/root-layout.tsx's Shell) query this on every mount — seeded for the
  // same reason as every other query here, not because this file has
  // anything of its own to say about that screen.
  client.setQueryData(
    [{ url: '/api/whats-new' }],
    { installedVersion: null, installedAt: null, pending: false },
  )

  store = createStore()
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </JotaiProvider>,
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

const classesOf = (el: Element | null | undefined) =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

const wrapper = () => container.querySelector('[data-slot="sidebar-wrapper"]')
const inset = () => container.querySelector('main[data-slot="sidebar-inset"]')
const sidebarContainer = () => container.querySelector('[data-slot="sidebar-container"]')
/** Every candidate backdrop anywhere in the document: an aria-hidden,
 *  pointer-events-none layer. Document-wide on purpose, so a backdrop
 *  rendered in the wrong place is still found (and then fails the "inside the
 *  wrapper" check) rather than silently missed. */
const backdrops = () =>
  [...document.querySelectorAll('[aria-hidden="true"]')].filter(
    // Not an icon: lucide icons inside controls can be aria-hidden and
    // pointer-events-none too, and are not a backdrop.
    (el) => classesOf(el).includes('pointer-events-none') && el.tagName.toLowerCase() !== 'svg',
  )
const catalogTokensIn = (el: Element | null | undefined) =>
  classesOf(el).filter((c) => ALL_CATALOG_TOKENS.has(c))

/** A compact, printable summary of the backdrop/glass/transparency state —
 *  so a failure prints what was there instead of a happy-dom element. */
function shellState() {
  const shell = wrapper()
  const found = backdrops()
  return {
    // The wrapper's own children other than a backdrop: the shell's chrome,
    // which must be the same three either way.
    wrapperChildren: [...(shell?.children ?? [])]
      .filter((c) => !found.includes(c))
      .map((c) => c.tagName),
    backdrops: found.length,
    backdropsInWrapper: found.filter((b) => !!shell?.contains(b)).length,
    backdropClasses: found.map((b) => catalogTokensIn(b).sort().join(' ')),
    backdropPatterns: found.map((b) => b.querySelectorAll('svg pattern').length),
    glass: GLASS.filter((g) => classesOf(inset()).includes(g)),
    insetPlainBg: classesOf(inset()).includes('bg-background'),
    transparentSidebar: classesOf(sidebarContainer()).includes(TRANSPARENT_SIDEBAR),
    patternsInDocument: document.querySelectorAll('pattern').length,
  }
}

const OFF = {
  wrapperChildren: ['HEADER', 'DIV', 'FOOTER'],
  backdrops: 0,
  backdropsInWrapper: 0,
  backdropClasses: [],
  backdropPatterns: [],
  glass: [],
  insetPlainBg: true,
  transparentSidebar: false,
  patternsInDocument: 0,
}

const tokensFor = (id: keyof typeof BACKGROUND_CLASS_NAME) =>
  BACKGROUND_CLASS_NAME[id].split(/\s+/).filter(Boolean).sort().join(' ')

function on(colour: keyof typeof BACKGROUND_CLASS_NAME | null, patterns: number) {
  return {
    wrapperChildren: ['HEADER', 'DIV', 'FOOTER'],
    backdrops: 1,
    backdropsInWrapper: 1,
    backdropClasses: [colour ? tokensFor(colour) : ''],
    backdropPatterns: [patterns],
    glass: [...GLASS],
    insetPlainBg: false,
    transparentSidebar: true,
    patternsInDocument: patterns,
  }
}

async function otherWindowWrites(key: string, newValue: string | null) {
  const oldValue = localStorage.getItem(key)
  if (newValue === null) localStorage.removeItem(key)
  else localStorage.setItem(key, newValue)
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }),
    )
  })
  await settle()
}

beforeEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
  errors.length = 0
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' ').slice(0, 300))
    realConsoleError(...args)
  }
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  console.error = realConsoleError
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  localStorage.clear()
  document.documentElement.className = ''
})

// --- off -----------------------------------------------------------------------------

describe('with no background chosen the shell is untouched', () => {
  test('nothing stored: no backdrop, no glass, no transparent sidebar', async () => {
    await mount('/library')
    expect(shellState()).toEqual(OFF)
  })

  test('both stored explicitly as none: same as nothing stored', async () => {
    localStorage.setItem(BG_KEY, '"none"')
    localStorage.setItem(PATTERN_KEY, '"none"')
    await mount('/library')
    expect(shellState()).toEqual(OFF)
  })

  for (const raw of ['{not json', '42', '{"id":"blue"}', '"magenta"', '"__proto__"', 'blue']) {
    test(`garbage in storage (${raw}) renders the plain shell, without errors`, async () => {
      localStorage.setItem(BG_KEY, raw)
      localStorage.setItem(PATTERN_KEY, raw)
      await mount('/library')
      expect(shellState()).toEqual(OFF)
      expect(errors).toEqual([])
    })
  }

  test('a pattern id in the background key and a colour id in the pattern key: plain shell', async () => {
    localStorage.setItem(BG_KEY, '"code"')
    localStorage.setItem(PATTERN_KEY, '"blue"')
    await mount('/library')
    expect(shellState()).toEqual(OFF)
  })

  test('no element anywhere carries a catalog colour class', async () => {
    await mount('/library')
    const coloured = [...document.querySelectorAll('[class]')].filter(
      (el) => catalogTokensIn(el).length > 0,
    )
    expect(coloured.length).toBe(0)
  })
})

// --- on ------------------------------------------------------------------------------

describe('a chosen background paints the backdrop and turns the chrome to glass', () => {
  for (const id of [...COLORS, ...GRADIENTS]) {
    test(`${id}: one backdrop in the wrapper with exactly its catalog classes`, async () => {
      localStorage.setItem(BG_KEY, JSON.stringify(id))
      await mount('/library')
      expect(shellState()).toEqual(on(id, 0))
    })
  }

  test('the backdrop is aria-hidden, takes no pointer events and holds nothing focusable', async () => {
    localStorage.setItem(BG_KEY, '"blue"')
    localStorage.setItem(PATTERN_KEY, '"code"')
    await mount('/library')
    const [backdrop] = backdrops()
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true')
    expect(classesOf(backdrop)).toContain('pointer-events-none')
    expect(backdrop?.querySelectorAll('a, button, input, select, textarea, [tabindex]').length).toBe(0)
    expect((backdrop?.textContent ?? '').trim()).toBe('')
  })

  test('a pattern over no colour is still active: backdrop with a pattern and no colour', async () => {
    localStorage.setItem(PATTERN_KEY, '"geometric"')
    await mount('/library')
    expect(shellState()).toEqual(on(null, 1))
  })

  test('a colour and a pattern together: the colour classes and one pattern', async () => {
    localStorage.setItem(BG_KEY, '"sunset"')
    localStorage.setItem(PATTERN_KEY, '"space"')
    await mount('/library')
    expect(shellState()).toEqual(on('sunset', 1))
  })

  test('the backdrop pattern fill resolves to its own <pattern>', async () => {
    localStorage.setItem(PATTERN_KEY, '"weather"')
    await mount('/library')
    const [backdrop] = backdrops()
    const rect = backdrop?.querySelector('rect[fill]')
    const ref = /^url\(#(.+)\)$/.exec(rect?.getAttribute('fill') ?? '')?.[1] ?? ''
    const target = document.getElementById(ref)
    expect(target?.tagName.toLowerCase()).toBe('pattern')
    expect(!!backdrop?.contains(target)).toBe(true)
  })

  test('a valid colour next to a garbage pattern: the colour applies, the pattern reads none', async () => {
    localStorage.setItem(BG_KEY, '"cyan"')
    localStorage.setItem(PATTERN_KEY, '"stripes"')
    await mount('/library')
    expect(shellState()).toEqual(on('cyan', 0))
  })

  test('the backdrop is there on a session page too (it belongs to the shell, not the page)', async () => {
    localStorage.setItem(BG_KEY, '"forest"')
    await mount('/projects/p1/sessions')
    expect(shellState()).toEqual(on('forest', 0))
  })
})

// --- live ----------------------------------------------------------------------------

describe('the shell follows the atoms live', () => {
  test('choosing a background, adding a pattern, then clearing both, round-trips to the plain shell', async () => {
    await mount('/library')
    expect(shellState()).toEqual(OFF)

    await act(async () => {
      store.set(backgroundAtom, 'ocean')
    })
    await settle()
    expect(shellState()).toEqual(on('ocean', 0))

    await act(async () => {
      store.set(backgroundPatternAtom, 'nature')
    })
    await settle()
    expect(shellState()).toEqual(on('ocean', 1))

    await act(async () => {
      store.set(backgroundAtom, 'none')
    })
    await settle()
    expect(shellState()).toEqual(on(null, 1))

    await act(async () => {
      store.set(backgroundPatternAtom, 'none')
    })
    await settle()
    expect(shellState()).toEqual(OFF)
  })

  test('another tab choosing a background is reflected here', async () => {
    await mount('/library')
    await otherWindowWrites(BG_KEY, '"indigo"')
    expect(shellState()).toEqual(on('indigo', 0))
    await otherWindowWrites(PATTERN_KEY, '"doodles"')
    expect(shellState()).toEqual(on('indigo', 1))
  })

  for (const raw of ['{not json', '42', '["red"]', '"chartreuse"', null]) {
    test(`another tab writing ${raw === null ? 'a removal' : raw} drops back to the plain shell, without errors`, async () => {
      localStorage.setItem(BG_KEY, '"pink"')
      localStorage.setItem(PATTERN_KEY, '"code"')
      await mount('/library')
      expect(shellState()).toEqual(on('pink', 1))

      await otherWindowWrites(BG_KEY, raw)
      await otherWindowWrites(PATTERN_KEY, raw)
      expect(shellState()).toEqual(OFF)
      expect(errors).toEqual([])
    })
  }
})
