// The highlight tint (features/appearance's `useHighlightTint`, mounted in `Shell`):
// when `backgroundAtom` is a colour or a gradient, `document.body` carries
// that hue's `HIGHLIGHT_TINT_CLASS_NAME[id]` tokens plus every
// `HIGHLIGHT_TINT_ALIAS_CLASS_NAME` token, so every hover/selected/open
// highlight reads the tinted `--accent`. With `'none'` — pattern or no
// pattern — body carries none of them. `<html>` never carries them (its
// `dark:` variant is a descendant selector and `.dark` sits on `<html>`).
//
// Two halves:
//   - the catalog contract, as values and as source text (Tailwind scans
//     catalog.ts as text, so a class assembled at runtime compiles to nothing);
//   - the shell integration, with tests/appearance-glass-surfaces.test.tsx's
//     harness: real router, seeded queries, offline transport, inert
//     EventSource.
//
// What these tests cannot see: whether the compiled CSS actually tints
// anything (happy-dom does not run Tailwind). That is a browser check.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { routeTree } from '../src/app/router'
import {
  HIGHLIGHT_TINT_ALIAS_CLASS_NAME,
  HIGHLIGHT_TINT_CLASS_NAME,
  BACKGROUND_CLASS_NAME,
} from '../src/features/appearance/lib/catalog'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { backgroundAtom } from '../src/shared/store/ui'

const BG_KEY = 'agentoo:background'
const PATTERN_KEY = 'agentoo:background-pattern'

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
type Id = (typeof COLORS)[number] | (typeof GRADIENTS)[number]

const tokensOf = (classes: string) => classes.split(/\s+/).filter(Boolean)

interface Oklch {
  l: number
  c: number
  h: number
}
const parseOklch = (body: string): Oklch => {
  const parts = body.split('_').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`bad oklch: ${body}`)
  const [l, c, h] = parts as [number, number, number]
  return { l, c, h }
}
/** The single `<prefix>[oklch(…)]` colour in a class string, light or dark. */
function stop(classes: string, prefix: string, dark: boolean): Oklch {
  const want = `${dark ? 'dark:' : ''}${prefix}[oklch(`
  const hits = tokensOf(classes).filter((t) => t.startsWith(want))
  if (hits.length !== 1) throw new Error(`expected one ${want}… in ${classes}, got ${hits.length}`)
  return parseOklch((hits[0] as string).slice(want.length, -')]'.length))
}
const backdropHueSource = (id: Id) => ((GRADIENTS as readonly string[]).includes(id) ? 'via-' : 'bg-')

const ACCENT_LIGHT = /^\[--accent:oklch\(([0-9._]+)\)\]$/
const ACCENT_DARK = /^dark:\[--accent:oklch\(([0-9._]+)\)\]$/
function accent(id: Id, dark: boolean): Oklch {
  const re = dark ? ACCENT_DARK : ACCENT_LIGHT
  const hits = tokensOf(HIGHLIGHT_TINT_CLASS_NAME[id])
    .map((t) => re.exec(t)?.[1])
    .filter((m): m is string => m !== undefined)
  if (hits.length !== 1) throw new Error(`expected one ${dark ? 'dark ' : ''}accent for ${id}`)
  return parseOklch(hits[0] as string)
}

// --- catalog contract ------------------------------------------------------------

describe('HIGHLIGHT_TINT_CLASS_NAME / HIGHLIGHT_TINT_ALIAS_CLASS_NAME catalog contract', () => {
  test('keys are exactly the colour and gradient ids, the same keys as BACKGROUND_CLASS_NAME', () => {
    expect(Object.keys(HIGHLIGHT_TINT_CLASS_NAME).sort()).toEqual([...COLORS, ...GRADIENTS].sort())
    expect(Object.keys(HIGHLIGHT_TINT_CLASS_NAME).sort()).toEqual(
      Object.keys(BACKGROUND_CLASS_NAME).sort(),
    )
    expect(Object.keys(HIGHLIGHT_TINT_CLASS_NAME)).not.toContain('none')
  })

  test('each value is exactly one light [--accent:oklch(…)] token and one dark: one', () => {
    const bad = Object.entries(HIGHLIGHT_TINT_CLASS_NAME)
      .filter(([, cls]) => {
        const toks = tokensOf(cls)
        return (
          toks.length !== 2 ||
          toks.filter((t) => ACCENT_LIGHT.test(t)).length !== 1 ||
          toks.filter((t) => ACCENT_DARK.test(t)).length !== 1
        )
      })
      .map(([id]) => id)
    expect(bad).toEqual([])
  })

  test("hue equals the backdrop's bg- hue (colours) or via- hue (gradients), in both themes", () => {
    const mismatches = [...COLORS, ...GRADIENTS].flatMap((id) =>
      [false, true].flatMap((dark) => {
        const want = stop(BACKGROUND_CLASS_NAME[id], backdropHueSource(id), dark).h
        const got = accent(id, dark).h
        return got === want ? [] : [`${id}${dark ? ' dark' : ''}: accent ${got} vs backdrop ${want}`]
      }),
    )
    expect(mismatches).toEqual([])
  })

  test('light accent is darker than the light backdrop; dark accent is lighter than the dark backdrop', () => {
    const bad = [...COLORS, ...GRADIENTS].flatMap((id) => {
      const src = backdropHueSource(id)
      const out: string[] = []
      const lightBg = stop(BACKGROUND_CLASS_NAME[id], src, false).l
      const darkBg = stop(BACKGROUND_CLASS_NAME[id], src, true).l
      if (!(accent(id, false).l < lightBg)) out.push(`${id} light ${accent(id, false).l} !< ${lightBg}`)
      if (!(accent(id, true).l > darkBg)) out.push(`${id} dark ${accent(id, true).l} !> ${darkBg}`)
      return out
    })
    expect(bad).toEqual([])
  })

  test('the alias class carries no oklch literal and re-points the four expected tokens', () => {
    expect(HIGHLIGHT_TINT_ALIAS_CLASS_NAME).not.toContain('oklch')
    const toks = tokensOf(HIGHLIGHT_TINT_ALIAS_CLASS_NAME)
    expect(toks).toContain('[--sidebar-accent:var(--accent)]')
    expect(toks).toContain('[--secondary:var(--accent)]')
    // --muted and --input only inside a scoped (arbitrary-variant) selector,
    // never unconditionally on body.
    expect(toks).not.toContain('[--muted:var(--accent)]')
    expect(toks).not.toContain('[--input:var(--accent)]')
    expect(toks.some((t) => t.endsWith(':[--muted:var(--accent)]'))).toBe(true)
    expect(toks.some((t) => t.startsWith('dark:') && t.endsWith(':[--input:var(--accent)]'))).toBe(
      true,
    )
  })

  test('both constants appear as literals in catalog.ts source, so Tailwind can scan them', async () => {
    const source = await Bun.file(
      new URL('../src/features/appearance/lib/catalog.ts', import.meta.url),
    ).text()
    const notLiteral = Object.entries(HIGHLIGHT_TINT_CLASS_NAME)
      .filter(([id, cls]) => !source.includes(`${id}: '${cls}'`))
      .map(([id]) => id)
    expect(notLiteral).toEqual([])
    expect(source.includes(`'${HIGHLIGHT_TINT_ALIAS_CLASS_NAME}'`)).toBe(true)
  })
})

// --- shell integration -------------------------------------------------------------

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

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
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

const unmount = async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}

const ALIAS = tokensOf(HIGHLIGHT_TINT_ALIAS_CLASS_NAME)
const ALL_TINT_TOKENS = [
  ...new Set([...Object.values(HIGHLIGHT_TINT_CLASS_NAME).flatMap(tokensOf), ...ALIAS]),
]
const bodyTokens = () => [...document.body.classList]
/** Which tint/alias tokens an element currently carries. */
const tintOn = (el: Element) => ALL_TINT_TOKENS.filter((t) => el.classList.contains(t))
const expectedFor = (id: Id) => [...tokensOf(HIGHLIGHT_TINT_CLASS_NAME[id]), ...ALIAS].sort()

beforeEach(() => {
  document.body.replaceChildren()
  document.body.className = ''
  localStorage.clear()
  document.documentElement.className = ''
  apiClient.setConfig({ transport: offlineTransport })
})

afterEach(async () => {
  await unmount()
  container?.remove()
})

afterAll(() => {
  apiClient.setConfig({ transport: originalTransport })
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
  localStorage.clear()
  document.body.className = ''
  document.documentElement.className = ''
})

describe('the shell puts the tint on <body> only for a colour or gradient', () => {
  test("'none' with no pattern: body carries no tint or alias token", async () => {
    await mount('/library')
    // The shell really rendered (else "no tokens" would be vacuous).
    expect(container.querySelector('main[data-slot="sidebar-inset"]')).not.toBeNull()
    expect(tintOn(document.body)).toEqual([])
    expect(tintOn(document.documentElement)).toEqual([])
  })

  test("'none' with pattern 'code': body still carries no tint or alias token", async () => {
    localStorage.setItem(PATTERN_KEY, '"code"')
    await mount('/library')
    expect(container.querySelector('main[data-slot="sidebar-inset"]')).not.toBeNull()
    expect(tintOn(document.body)).toEqual([])
    expect(tintOn(document.documentElement)).toEqual([])
  })

  test("explicit '\"none\"' stored with a pattern: still nothing", async () => {
    localStorage.setItem(BG_KEY, '"none"')
    localStorage.setItem(PATTERN_KEY, '"space"')
    await mount('/projects/p1/sessions')
    expect(tintOn(document.body)).toEqual([])
  })

  test("'blue': body carries every blue token plus every alias token, and nothing else of the tint", async () => {
    localStorage.setItem(BG_KEY, '"blue"')
    await mount('/library')
    expect(tintOn(document.body).sort()).toEqual(expectedFor('blue'))
    expect(tintOn(document.documentElement)).toEqual([])
  })

  test('a gradient with a pattern on a project tab: its own tokens plus the alias', async () => {
    localStorage.setItem(BG_KEY, '"ocean"')
    localStorage.setItem(PATTERN_KEY, '"weather"')
    await mount('/projects/p1/sessions')
    expect(tintOn(document.body).sort()).toEqual(expectedFor('ocean'))
    expect(tintOn(document.documentElement)).toEqual([])
  })

  test('unrelated body classes survive the tint being added and removed', async () => {
    document.body.classList.add('keep-me')
    localStorage.setItem(BG_KEY, '"green"')
    await mount('/library')
    expect(bodyTokens()).toContain('keep-me')
    await unmount()
    expect(bodyTokens()).toEqual(['keep-me'])
  })

  test("live switching: blue -> sunset swaps hue tokens, -> 'none' clears all, unmount clears all", async () => {
    localStorage.setItem(BG_KEY, '"blue"')
    await mount('/library')
    expect(tintOn(document.body).sort()).toEqual(expectedFor('blue'))

    await act(async () => {
      store.set(backgroundAtom, 'sunset')
    })
    await settle()
    const blueOnly = tokensOf(HIGHLIGHT_TINT_CLASS_NAME.blue).filter(
      (t) => !tokensOf(HIGHLIGHT_TINT_CLASS_NAME.sunset).includes(t),
    )
    expect(blueOnly.length).toBeGreaterThan(0)
    expect(blueOnly.filter((t) => document.body.classList.contains(t))).toEqual([])
    expect(tintOn(document.body).sort()).toEqual(expectedFor('sunset'))
    expect(tintOn(document.documentElement)).toEqual([])

    await act(async () => {
      store.set(backgroundAtom, 'none')
    })
    await settle()
    expect(tintOn(document.body)).toEqual([])

    await act(async () => {
      store.set(backgroundAtom, 'purple')
    })
    await settle()
    expect(tintOn(document.body).sort()).toEqual(expectedFor('purple'))

    await unmount()
    expect(tintOn(document.body)).toEqual([])
    expect(tintOn(document.documentElement)).toEqual([])
  })

  test('switching between two ids that share a hue (sunset -> red) leaves the shared tokens on', async () => {
    // sunset and red share the same accent by design: the cleanup of the old
    // id must not strip tokens the new id also needs.
    localStorage.setItem(BG_KEY, '"sunset"')
    await mount('/library')
    await act(async () => {
      store.set(backgroundAtom, 'red')
    })
    await settle()
    expect(tintOn(document.body).sort()).toEqual(expectedFor('red'))
  })
})
