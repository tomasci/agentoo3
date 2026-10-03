// The reader's accent colour (features/appearance's `useAccentColor`, mounted
// in `RootLayout`): when `accentColorAtom` is a colour or a gradient,
// `document.body` carries that id's `ACCENT_COLOR_CLASS_NAME[id]` tokens (one
// light and one `dark:` re-point of `--primary`) plus the
// `ACCENT_COLOR_FIXED_TONE_CLASS_NAME` token that scopes `--primary` back to
// `var(--foreground)` under `[data-fixed-tone]`/Progress's indicator. With
// `'none'`, body carries none of it. Independent of the background: its own
// atom, its own key, and no token shared with the highlight tint
// (`useHighlightTint`, mounted in `Shell` — tests/appearance-highlight-tint.test.tsx).
//
// Three parts:
//   - the catalog contract, as values (shape, hue, sRGB gamut, WCAG contrast
//     against globals.css's own `--primary-foreground`) and as source text
//     (Tailwind scans catalog.ts as text);
//   - the `data-fixed-tone` markers on `SuggestionDiff` (StatusDot's is in
//     tests/shared-components.test.tsx), checked against the fixed-tone
//     token's own selector rather than a copy of it;
//   - the mount, through the real router, using
//     tests/appearance-glass-surfaces.test.tsx's harness: seeded queries,
//     offline transport, inert EventSource — including the bare-shell editor
//     launcher, where the accent applies but the highlight tint must not.
//
// What these tests cannot see: whether the compiled CSS actually recolours a
// button (happy-dom does not run Tailwind). That is a browser check.
// The store itself is covered in tests/appearance-store.test.ts, and the
// settings radio group in tests/appearance-settings.test.tsx.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AxiosInstance } from 'axios'
import i18next from 'i18next'
import { createStore, Provider as JotaiProvider } from 'jotai'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { routeTree } from '../src/app/router'
import {
  ACCENT_COLOR_CLASS_NAME,
  ACCENT_COLOR_FIXED_TONE_CLASS_NAME,
  accentColorTileClassName,
  BACKGROUND_CLASS_NAME,
  HIGHLIGHT_TINT_ALIAS_CLASS_NAME,
  HIGHLIGHT_TINT_CLASS_NAME,
} from '../src/features/appearance/lib/catalog'
import { SuggestionDiff } from '../src/features/library/components/suggestion-diff'
import { client as apiClient } from '../src/shared/api/generated/.kubb/client'
import { isBareShellPath } from '../src/shared/store/tabs'
import { accentColorAtom, backgroundAtom } from '../src/shared/store/ui'
import { Progress } from '../src/shared/ui/progress'

const BG_KEY = 'agentoo:background'
const ACCENT_KEY = 'agentoo:accent-color'
const LAUNCHER = '/projects/p1/sessions/s1/editor'

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
const IDS = [...COLORS, ...GRADIENTS] as const
type Id = (typeof IDS)[number]

const tokensOf = (classes: string) => classes.split(/\s+/).filter(Boolean)

interface Oklch {
  l: number
  c: number
  h: number
}
const parseOklch = (body: string, sep: RegExp): Oklch => {
  const parts = body.trim().split(sep).map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`bad oklch: ${body}`)
  const [l, c, h] = parts as [number, number, number]
  return { l, c, h }
}

/** The single `<prefix>[oklch(…)]` colour in a backdrop class string. */
function backdropStop(classes: string, prefix: string, dark: boolean): Oklch {
  const want = `${dark ? 'dark:' : ''}${prefix}[oklch(`
  const hits = tokensOf(classes).filter((t) => t.startsWith(want))
  if (hits.length !== 1) throw new Error(`expected one ${want}… in ${classes}, got ${hits.length}`)
  return parseOklch((hits[0] as string).slice(want.length, -')]'.length), /_/)
}
const backdropHueSource = (id: Id) => ((GRADIENTS as readonly string[]).includes(id) ? 'via-' : 'bg-')

const PRIMARY_LIGHT = /^\[--primary:oklch\(([0-9._]+)\)\]$/
const PRIMARY_DARK = /^dark:\[--primary:oklch\(([0-9._]+)\)\]$/
function primary(id: Id, dark: boolean): Oklch {
  const re = dark ? PRIMARY_DARK : PRIMARY_LIGHT
  const hits = tokensOf(ACCENT_COLOR_CLASS_NAME[id])
    .map((t) => re.exec(t)?.[1])
    .filter((m): m is string => m !== undefined)
  if (hits.length !== 1) throw new Error(`expected one ${dark ? 'dark ' : ''}--primary for ${id}`)
  return parseOklch(hits[0] as string, /_/)
}

// OKLCH -> OKLab -> linear sRGB (Björn Ottosson's published matrices), and
// WCAG 2.x relative luminance / contrast ratio on the linear values.
function linearSrgb({ l: L, c: C, h: H }: Oklch): [number, number, number] {
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}
const luminance = (c: Oklch) => {
  const [r, g, b] = linearSrgb(c)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (x: Oklch, y: Oklch) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** globals.css's own `--primary-foreground`, in `:root` (light) and `.dark`. */
async function primaryForeground(): Promise<{ light: Oklch; dark: Oklch }> {
  const css = await Bun.file(new URL('../src/styles/globals.css', import.meta.url)).text()
  const inBlock = (selector: string) => {
    const block = new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1]
    const value = block && /--primary-foreground:\s*oklch\(([^)]*)\)/.exec(block)?.[1]
    if (!value) throw new Error(`no --primary-foreground in ${selector}`)
    return parseOklch(value, /\s+/)
  }
  return { light: inBlock(':root'), dark: inBlock('.dark') }
}

// --- catalog contract --------------------------------------------------------------

describe('ACCENT_COLOR_CLASS_NAME catalog contract', () => {
  test('keys are exactly the colour and gradient ids, the same keys as BACKGROUND_CLASS_NAME', () => {
    expect(Object.keys(ACCENT_COLOR_CLASS_NAME).sort()).toEqual([...IDS].sort())
    expect(Object.keys(ACCENT_COLOR_CLASS_NAME).sort()).toEqual(Object.keys(BACKGROUND_CLASS_NAME).sort())
    expect(Object.keys(ACCENT_COLOR_CLASS_NAME)).not.toContain('none')
  })

  test('each value is exactly one light [--primary:oklch(…)] token and one dark: one', () => {
    const bad = Object.entries(ACCENT_COLOR_CLASS_NAME)
      .filter(([, cls]) => {
        const toks = tokensOf(cls)
        return (
          toks.length !== 2 ||
          toks.filter((t) => PRIMARY_LIGHT.test(t)).length !== 1 ||
          toks.filter((t) => PRIMARY_DARK.test(t)).length !== 1
        )
      })
      .map(([id]) => id)
    expect(bad).toEqual([])
  })

  test('never re-points --primary-foreground or --ring (or anything else)', () => {
    const bad = Object.entries(ACCENT_COLOR_CLASS_NAME)
      .filter(([, cls]) => /--primary-foreground|--ring|--sidebar-primary|--accent/.test(cls))
      .map(([id]) => id)
    expect(bad).toEqual([])
    expect(ACCENT_COLOR_FIXED_TONE_CLASS_NAME).not.toMatch(/--primary-foreground|--ring/)
  })

  test("hue equals the backdrop's bg- hue (colours) or via- hue (gradients), in both themes", () => {
    const mismatches = IDS.flatMap((id) =>
      [false, true].flatMap((dark) => {
        const want = backdropStop(BACKGROUND_CLASS_NAME[id], backdropHueSource(id), dark).h
        const got = primary(id, dark).h
        return got === want ? [] : [`${id}${dark ? ' dark' : ''}: --primary ${got} vs backdrop ${want}`]
      }),
    )
    expect(mismatches).toEqual([])
  })

  test('the contrast maths is sane: black on white is 21:1, OKLab L0.5 grey on white is 6:1', () => {
    // Guards the helper the next two tests rely on, so a broken matrix
    // cannot quietly pass every colour. An achromatic OKLab L has linear
    // luminance L^3, so L0.5 is Y=0.125 and (1 + 0.05) / (0.125 + 0.05) = 6.
    expect(contrast({ l: 0, c: 0, h: 0 }, { l: 1, c: 0, h: 0 })).toBeCloseTo(21, 4)
    expect(linearSrgb({ l: 1, c: 0, h: 0 }).map((v) => Number(v.toFixed(4)))).toEqual([1, 1, 1])
    expect(luminance({ l: 0.5, c: 0, h: 0 })).toBeCloseTo(0.125, 6)
    expect(contrast({ l: 0.5, c: 0, h: 0 }, { l: 1, c: 0, h: 0 })).toBeCloseTo(6, 6)
    // A saturated colour lands where the sRGB reference says: pure sRGB red
    // is oklch(0.628 0.2577 29.23) with luminance 0.2126.
    expect(luminance({ l: 0.62796, c: 0.25768, h: 29.2339 })).toBeCloseTo(0.2126, 3)
  })

  test('every value, light and dark, is inside the sRGB gamut', () => {
    const out = IDS.flatMap((id) =>
      [false, true].flatMap((dark) => {
        const rgb = linearSrgb(primary(id, dark))
        return rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6)
          ? []
          : [`${id}${dark ? ' dark' : ''}: ${rgb.map((v) => v.toFixed(4)).join(' ')}`]
      }),
    )
    expect(out).toEqual([])
  })

  test("every value has WCAG contrast >= 4.5:1 against globals.css's --primary-foreground, per theme", async () => {
    const fg = await primaryForeground()
    // The values the catalog's own comment was written against — if
    // globals.css moves, this says so rather than silently re-baselining.
    expect(fg.light).toEqual({ l: 0.985, c: 0, h: 0 })
    expect(fg.dark).toEqual({ l: 0.205, c: 0, h: 0 })
    const low = IDS.flatMap((id) =>
      [false, true].flatMap((dark) => {
        const ratio = contrast(primary(id, dark), dark ? fg.dark : fg.light)
        return ratio >= 4.5 ? [] : [`${id}${dark ? ' dark' : ''}: ${ratio.toFixed(2)}:1`]
      }),
    )
    expect(low).toEqual([])
  })

  test('the fixed-tone class is one token, scoping --primary to var(--foreground) for the two marker selectors', () => {
    expect(tokensOf(ACCENT_COLOR_FIXED_TONE_CLASS_NAME)).toEqual([ACCENT_COLOR_FIXED_TONE_CLASS_NAME])
    expect(ACCENT_COLOR_FIXED_TONE_CLASS_NAME).not.toContain('oklch')
    expect(ACCENT_COLOR_FIXED_TONE_CLASS_NAME.endsWith(']:[--primary:var(--foreground)]')).toBe(true)
    const selector = fixedToneSelector()
    expect(selector).toContain('[data-fixed-tone]')
    expect(selector).toContain('[data-slot=progress-indicator]')
  })

  test('all constants appear as literals in catalog.ts source, so Tailwind can scan them', async () => {
    const source = await Bun.file(new URL('../src/features/appearance/lib/catalog.ts', import.meta.url)).text()
    const notLiteral = Object.entries(ACCENT_COLOR_CLASS_NAME)
      .filter(([id, cls]) => !source.includes(`${id}: '${cls}'`))
      .map(([id]) => id)
    expect(notLiteral).toEqual([])
    expect(source.includes(`'${ACCENT_COLOR_FIXED_TONE_CLASS_NAME}'`)).toBe(true)
    expect(source.includes("'bg-foreground'")).toBe(true)
    expect(source).toMatch(/`bg-primary \$\{ACCENT_COLOR_CLASS_NAME\[id\]\}`/)
  })

  test('no class token is shared between the accent set and the highlight-tint set', () => {
    // Both hooks add/remove tokens on the same <body>: a shared token would
    // be stripped by one hook's cleanup while the other still needs it.
    const accentSet = new Set([
      ...Object.values(ACCENT_COLOR_CLASS_NAME).flatMap(tokensOf),
      ...tokensOf(ACCENT_COLOR_FIXED_TONE_CLASS_NAME),
    ])
    const highlightSet = new Set([
      ...Object.values(HIGHLIGHT_TINT_CLASS_NAME).flatMap(tokensOf),
      ...tokensOf(HIGHLIGHT_TINT_ALIAS_CLASS_NAME),
    ])
    expect([...accentSet].filter((t) => highlightSet.has(t))).toEqual([])
  })

  test("accentColorTileClassName: 'none' is the plain foreground tile, a colour is bg-primary plus its own tokens", () => {
    expect(accentColorTileClassName('none')).toBe('bg-foreground')
    expect(tokensOf(accentColorTileClassName('blue'))).toEqual([
      'bg-primary',
      ...tokensOf(ACCENT_COLOR_CLASS_NAME.blue),
    ])
    const bad = IDS.filter(
      (id) => accentColorTileClassName(id) !== `bg-primary ${ACCENT_COLOR_CLASS_NAME[id]}`,
    )
    expect(bad).toEqual([])
  })
})

/** The CSS selector inside the fixed-tone arbitrary variant
 *  (`[&_<selector>]:…`, `_` being Tailwind's space): the subtree it scopes,
 *  as a descendant of whatever element carries the class (<body>). */
function fixedToneSelector(): string {
  const m = /^\[&_(.+)\]:\[--primary:var\(--foreground\)\]$/.exec(ACCENT_COLOR_FIXED_TONE_CLASS_NAME)
  if (!m?.[1]) throw new Error(`unexpected fixed-tone shape: ${ACCENT_COLOR_FIXED_TONE_CLASS_NAME}`)
  return m[1].replaceAll('_', ' ')
}

// --- markers --------------------------------------------------------------------------

describe('fixed-tone markers', () => {
  const cimode = i18next.createInstance()
  const ready = cimode.init({ lng: 'cimode', fallbackLng: 'cimode' })

  const html = (markup: string) => {
    const el = document.createElement('div')
    el.innerHTML = markup
    return el
  }

  test("SuggestionDiff's root carries data-fixed-tone and is matched by the fixed-tone selector", async () => {
    await ready
    const host = html(
      renderToStaticMarkup(
        <I18nextProvider i18n={cimode}>
          <SuggestionDiff before={'a\nb\n'} after={'a\nc\n'} />
        </I18nextProvider>,
      ),
    )
    const diffRoot = host.firstElementChild
    expect(diffRoot?.hasAttribute('data-fixed-tone')).toBe(true)
    // The diff really rendered add/remove rows under it (not an empty shell).
    expect(diffRoot?.textContent).toContain('b')
    expect(diffRoot?.textContent).toContain('c')
    expect(diffRoot?.matches(fixedToneSelector())).toBe(true)
  })

  test("Progress's own indicator is matched by the fixed-tone selector", () => {
    const host = html(renderToStaticMarkup(<Progress value={40} />))
    const indicator = host.querySelector('[data-slot="progress-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator?.matches(fixedToneSelector())).toBe(true)
  })
})

// --- mount through the real router ------------------------------------------------------

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
let router: ReturnType<typeof createRouter>

async function mount(path: string) {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
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

const set = async <V,>(atom: Parameters<typeof store.set>[0], value: V) => {
  await act(async () => {
    ;(store.set as (a: unknown, v: V) => void)(atom, value)
  })
  await settle()
}

const FIXED = tokensOf(ACCENT_COLOR_FIXED_TONE_CLASS_NAME)
const ALL_ACCENT_TOKENS = [
  ...new Set([...Object.values(ACCENT_COLOR_CLASS_NAME).flatMap(tokensOf), ...FIXED]),
]
const ALL_HIGHLIGHT_TOKENS = [
  ...new Set([
    ...Object.values(HIGHLIGHT_TINT_CLASS_NAME).flatMap(tokensOf),
    ...tokensOf(HIGHLIGHT_TINT_ALIAS_CLASS_NAME),
  ]),
]
const accentOn = (el: Element) => ALL_ACCENT_TOKENS.filter((t) => el.classList.contains(t)).sort()
const highlightOn = (el: Element) => ALL_HIGHLIGHT_TOKENS.filter((t) => el.classList.contains(t)).sort()
const expectedAccent = (id: Id) => [...tokensOf(ACCENT_COLOR_CLASS_NAME[id]), ...FIXED].sort()
const expectedHighlight = (id: Id) =>
  [...tokensOf(HIGHLIGHT_TINT_CLASS_NAME[id]), ...tokensOf(HIGHLIGHT_TINT_ALIAS_CLASS_NAME)].sort()
const shellRendered = () => container.querySelector('main[data-slot="sidebar-inset"]') !== null

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

describe('useAccentColor puts the accent on <body> only for a colour or gradient', () => {
  test("'none' leaves body.className exactly as it is with nothing stored at all", async () => {
    await mount('/library')
    expect(shellRendered()).toBe(true)
    const baseline = document.body.className
    expect(accentOn(document.body)).toEqual([])
    await unmount()
    container.remove()

    for (const raw of ['"none"', '{garbage', '"code"']) {
      document.body.className = ''
      localStorage.setItem(ACCENT_KEY, raw)
      await mount('/library')
      expect({ raw, cls: document.body.className }).toEqual({ raw, cls: baseline })
      expect(accentOn(document.documentElement)).toEqual([])
      await unmount()
      container.remove()
    }
  })

  test("'blue': exactly blue's tokens plus the fixed-tone token on body, none on <html>", async () => {
    localStorage.setItem(ACCENT_KEY, '"blue"')
    await mount('/library')
    expect(shellRendered()).toBe(true)
    expect(accentOn(document.body)).toEqual(expectedAccent('blue'))
    expect(accentOn(document.documentElement)).toEqual([])
    // An accent alone draws no highlight tint: that one follows the background.
    expect(highlightOn(document.body)).toEqual([])
  })

  test('unrelated body classes survive the accent being added and removed', async () => {
    document.body.classList.add('keep-me')
    localStorage.setItem(ACCENT_KEY, '"green"')
    await mount('/library')
    expect(document.body.classList.contains('keep-me')).toBe(true)
    await unmount()
    expect([...document.body.classList]).toEqual(['keep-me'])
  })

  test("live switching: blue -> sunset swaps tokens, -> 'none' clears all, unmount clears all", async () => {
    localStorage.setItem(ACCENT_KEY, '"blue"')
    await mount('/library')
    expect(accentOn(document.body)).toEqual(expectedAccent('blue'))

    await set(accentColorAtom, 'sunset')
    const blueOnly = tokensOf(ACCENT_COLOR_CLASS_NAME.blue)
    expect(blueOnly.filter((t) => document.body.classList.contains(t))).toEqual([])
    expect(accentOn(document.body)).toEqual(expectedAccent('sunset'))

    await set(accentColorAtom, 'none')
    expect(accentOn(document.body)).toEqual([])

    await set(accentColorAtom, 'purple')
    expect(accentOn(document.body)).toEqual(expectedAccent('purple'))

    await unmount()
    expect(accentOn(document.body)).toEqual([])
    expect(accentOn(document.documentElement)).toEqual([])
  })

  test('switching between two ids that share every token (red -> sunset) keeps them on', async () => {
    expect(ACCENT_COLOR_CLASS_NAME.sunset).toBe(ACCENT_COLOR_CLASS_NAME.red)
    localStorage.setItem(ACCENT_KEY, '"red"')
    await mount('/library')
    await set(accentColorAtom, 'sunset')
    expect(accentOn(document.body)).toEqual(expectedAccent('sunset'))
  })
})

describe('the bare-shell editor launcher', () => {
  test('the launcher path really is a bare-shell path', () => {
    expect(isBareShellPath(LAUNCHER)).toBe(true)
  })

  test('carries the accent but not the highlight tint, even with a background chosen', async () => {
    localStorage.setItem(BG_KEY, '"red"')
    localStorage.setItem(ACCENT_KEY, '"blue"')
    await mount(LAUNCHER)
    // No shell rendered, but the launcher itself did.
    expect(document.querySelectorAll('[data-slot="sidebar-wrapper"]').length).toBe(0)
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0)

    expect(accentOn(document.body)).toEqual(expectedAccent('blue'))
    expect(highlightOn(document.body)).toEqual([])
  })

  test('the accent follows a live change on the launcher too', async () => {
    localStorage.setItem(ACCENT_KEY, '"blue"')
    await mount(LAUNCHER)
    await set(accentColorAtom, 'forest')
    expect(accentOn(document.body)).toEqual(expectedAccent('forest'))
    await set(accentColorAtom, 'none')
    expect(accentOn(document.body)).toEqual([])
  })

  test('navigating from the launcher into the shell keeps the accent and adds the tint', async () => {
    localStorage.setItem(BG_KEY, '"red"')
    localStorage.setItem(ACCENT_KEY, '"blue"')
    await mount(LAUNCHER)
    await act(async () => {
      await router.navigate({ to: '/library' })
    })
    await settle()
    expect(shellRendered()).toBe(true)
    expect(accentOn(document.body)).toEqual(expectedAccent('blue'))
    expect(highlightOn(document.body)).toEqual(expectedHighlight('red'))
  })
})

describe('background and accent are independent', () => {
  const COMBOS = [
    ['none', 'none'],
    ['red', 'none'],
    ['none', 'blue'],
    ['red', 'blue'],
  ] as const

  for (const [bg, accent] of COMBOS) {
    test(`background ${bg} x accent ${accent}: each set reflects only its own atom`, async () => {
      localStorage.setItem(BG_KEY, JSON.stringify(bg))
      localStorage.setItem(ACCENT_KEY, JSON.stringify(accent))
      await mount('/library')
      expect(shellRendered()).toBe(true)
      expect(highlightOn(document.body)).toEqual(bg === 'none' ? [] : expectedHighlight(bg))
      expect(accentOn(document.body)).toEqual(accent === 'none' ? [] : expectedAccent(accent))
    })
  }

  test("clearing one live never strips the other's tokens", async () => {
    localStorage.setItem(BG_KEY, '"red"')
    localStorage.setItem(ACCENT_KEY, '"red"')
    await mount('/library')
    expect(highlightOn(document.body)).toEqual(expectedHighlight('red'))
    expect(accentOn(document.body)).toEqual(expectedAccent('red'))

    await set(accentColorAtom, 'none')
    expect(accentOn(document.body)).toEqual([])
    expect(highlightOn(document.body)).toEqual(expectedHighlight('red'))

    await set(accentColorAtom, 'teal')
    await set(backgroundAtom, 'none')
    expect(highlightOn(document.body)).toEqual([])
    expect(accentOn(document.body)).toEqual(expectedAccent('teal'))
    expect(store.get(accentColorAtom)).toBe('teal')
    expect(localStorage.getItem(BG_KEY)).toBe('"none"')
    expect(localStorage.getItem(ACCENT_KEY)).toBe('"teal"')
  })
})
