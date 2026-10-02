// features/appearance/lib/catalog.ts and the `BackgroundPattern` it feeds,
// as contracts rather than as pictures:
//
// - every colour/gradient's class string is a source literal (Tailwind's
//   scanner reads source text, so a class assembled at runtime compiles to
//   nothing) and carries both a light and a `dark:` colour token, stop for
//   stop for a gradient;
// - the settings grids list the spec's ids in the spec's order;
// - each pattern's icons are real lucide-react exports and render;
// - several `BackgroundPattern`s mounted at once get unique `<pattern id>`s,
//   and each `rect fill="url(#…)"` points at its *own* svg's pattern, never a
//   neighbour's.
//
// Preview geometry and the preview icon opacity are deliberately not asserted
// (they are being retuned separately); nor is the class of the 'none' tile.

import { afterEach, expect, test } from 'bun:test'
import * as lucide from 'lucide-react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BackgroundPattern } from '../src/features/appearance'
import {
  BACKGROUND_CLASS_NAME,
  BACKGROUND_OPTIONS,
  backgroundTileClassName,
  PATTERN_ICONS,
  PATTERN_OPTIONS,
} from '../src/features/appearance/lib/catalog'

const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
const PATTERNS = ['code', 'space', 'nature', 'weather', 'doodles', 'geometric'] as const

const tokensOf = (classes: string) => classes.split(/\s+/).filter(Boolean)
/** A colour-carrying background utility: `bg-…` other than a gradient
 *  direction (`bg-linear-…`), or a gradient stop `from-/via-/to-…`. Returns
 *  the utility kind, or null for anything else. */
const colourKind = (token: string): 'bg' | 'from' | 'via' | 'to' | null => {
  const m = /^(bg|from|via|to)-(.+)$/.exec(token)
  if (!m) return null
  if (m[1] === 'bg' && /^(linear|radial|conic)-/.test(m[2] ?? '')) return null
  return m[1] as 'bg' | 'from' | 'via' | 'to'
}
const lightKinds = (classes: string) =>
  tokensOf(classes)
    .filter((t) => !t.includes(':'))
    .map(colourKind)
    .filter(Boolean)
    .sort()
const darkKinds = (classes: string) =>
  tokensOf(classes)
    .filter((t) => t.startsWith('dark:') && t.split(':').length === 2)
    .map((t) => colourKind(t.slice('dark:'.length)))
    .filter(Boolean)
    .sort()

// --- BACKGROUND_CLASS_NAME --------------------------------------------------------

test('there is a class string for every colour and gradient, and for nothing else', () => {
  expect(Object.keys(BACKGROUND_CLASS_NAME).sort()).toEqual([...COLORS, ...GRADIENTS].sort())
})

test('every colour carries one light bg- token and one dark:bg- token', () => {
  const bad = COLORS.filter((id) => {
    const cls = BACKGROUND_CLASS_NAME[id]
    return lightKinds(cls).join() !== 'bg' || darkKinds(cls).join() !== 'bg'
  })
  expect(bad).toEqual([])
})

test('every gradient has a direction and light from/via/to stops matched by dark: ones', () => {
  const bad = GRADIENTS.filter((id) => {
    const cls = BACKGROUND_CLASS_NAME[id]
    const hasDirection = tokensOf(cls).some((t) => /^bg-(linear|radial|conic)-/.test(t))
    return (
      !hasDirection ||
      lightKinds(cls).join() !== 'from,to,via' ||
      darkKinds(cls).join() !== 'from,to,via'
    )
  })
  expect(bad).toEqual([])
})

test('no two backgrounds share a class string', () => {
  const values = Object.values(BACKGROUND_CLASS_NAME)
  expect(new Set(values).size).toBe(values.length)
})

test('every class string appears verbatim in catalog.ts, so Tailwind can scan it', async () => {
  const source = await Bun.file(
    new URL('../src/features/appearance/lib/catalog.ts', import.meta.url),
  ).text()
  const notLiteral = Object.entries(BACKGROUND_CLASS_NAME)
    .filter(([, cls]) => !source.includes(`'${cls}'`))
    .map(([id]) => id)
  expect(notLiteral).toEqual([])
})

test('backgroundTileClassName returns the catalog class for every non-none id', () => {
  const wrong = [...COLORS, ...GRADIENTS].filter(
    (id) => backgroundTileClassName(id) !== BACKGROUND_CLASS_NAME[id],
  )
  expect(wrong).toEqual([])
  // 'none' gets *some* surface class (its exact value is being changed
  // concurrently, so only that it is a non-empty, non-catalog string).
  const none = backgroundTileClassName('none')
  expect(typeof none).toBe('string')
  expect(none.trim().length).toBeGreaterThan(0)
  expect(Object.values(BACKGROUND_CLASS_NAME)).not.toContain(none)
})

// --- option order ------------------------------------------------------------------

test('the background grid is none, then the 12 colours, then the 5 gradients, in order', () => {
  expect(BACKGROUND_OPTIONS.map((o) => o.id)).toEqual(['none', ...COLORS, ...GRADIENTS])
})

test('the pattern grid is none, then the 6 patterns, in order', () => {
  expect(PATTERN_OPTIONS.map((o) => o.id)).toEqual(['none', ...PATTERNS])
})

// --- pattern icons ---------------------------------------------------------------

test('there is an icon list for every pattern and nothing else', () => {
  expect(Object.keys(PATTERN_ICONS).sort()).toEqual([...PATTERNS].sort())
})

test('every pattern icon is a real lucide-react export', () => {
  const lucideExports = new Set<unknown>(Object.values(lucide))
  const bad: string[] = []
  for (const id of PATTERNS) {
    const icons = PATTERN_ICONS[id]
    if (icons.length === 0) bad.push(`${id}: empty`)
    icons.forEach((icon, i) => {
      if (icon === undefined || icon === null) bad.push(`${id}[${i}]: ${String(icon)}`)
      else if (!lucideExports.has(icon)) bad.push(`${id}[${i}]: not a lucide-react export`)
    })
  }
  expect(bad).toEqual([])
})

// --- BackgroundPattern rendering ----------------------------------------------------

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  container?.remove()
  container = undefined
})

async function render(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' ').slice(0, 300))
  }
  try {
    await act(async () => {
      root?.render(node)
    })
  } finally {
    console.error = realError
  }
  return errors
}

/** Every `<pattern id>` and every `url(#…)` fill under `scope`, with whether
 *  each fill resolves to a `<pattern>` inside the *same* `<svg>`. */
function patternWiring(scope: ParentNode) {
  const ids = [...scope.querySelectorAll('pattern')].map((p) => p.getAttribute('id') ?? '')
  const fills = [...scope.querySelectorAll('rect[fill]')]
    .map((rect) => ({ rect, m: /^url\(#(.+)\)$/.exec(rect.getAttribute('fill') ?? '') }))
    .filter((f) => f.m)
    .map(({ rect, m }) => {
      const ref = m?.[1] ?? ''
      const target = document.getElementById(ref)
      return {
        ref,
        resolves: target?.tagName.toLowerCase() === 'pattern',
        sameSvg: !!target && target.closest('svg') === rect.closest('svg'),
      }
    })
  return { ids, fills }
}

test('each pattern renders its icons inside an aria-hidden svg <pattern>, without errors', async () => {
  const errors = await render(
    <>
      {PATTERNS.map((p) => (
        <div key={p} data-pattern={p}>
          <BackgroundPattern pattern={p} />
        </div>
      ))}
    </>,
  )
  expect(errors).toEqual([])
  const bad: string[] = []
  for (const p of PATTERNS) {
    const host = container?.querySelector(`[data-pattern="${p}"]`)
    const svg = host?.querySelector(':scope > svg')
    if (svg?.getAttribute('aria-hidden') !== 'true') bad.push(`${p}: svg not aria-hidden`)
    const pattern = svg?.querySelector('pattern')
    if (!pattern) {
      bad.push(`${p}: no <pattern>`)
      continue
    }
    // lucide icons render as nested <svg class="lucide …">.
    const icons = pattern.querySelectorAll('svg.lucide')
    if (icons.length === 0) bad.push(`${p}: no icons rendered`)
    // Every distinct icon in the list shows up at least once.
    const expected = PATTERN_ICONS[p].length
    const distinct = new Set([...icons].map((i) => i.getAttribute('class'))).size
    if (distinct < expected) bad.push(`${p}: ${distinct}/${expected} distinct icons`)
  }
  expect(bad).toEqual([])
})

test('the same pattern mounted many times gets a unique id each, wired to its own svg', async () => {
  // Three copies of every pattern: 18 tiles, six of them colliding by name
  // three ways, which is exactly the shell-backdrop-plus-previews situation.
  const errors = await render(
    <>
      {[0, 1, 2].flatMap((n) => PATTERNS.map((p) => <BackgroundPattern key={`${p}-${n}`} pattern={p} />))}
    </>,
  )
  expect(errors).toEqual([])
  const { ids, fills } = patternWiring(container as HTMLDivElement)
  expect(ids).toHaveLength(18)
  expect(ids.filter((id) => id === '')).toEqual([])
  expect(new Set(ids).size).toBe(18)
  expect(fills).toHaveLength(18)
  expect(fills.filter((f) => !f.resolves || !f.sameSvg)).toEqual([])
})

test('patterns in two separate React roots still get distinct ids', async () => {
  await render(<BackgroundPattern pattern="code" />)
  const second = document.createElement('div')
  document.body.append(second)
  const secondRoot = createRoot(second)
  await act(async () => {
    secondRoot.render(<BackgroundPattern pattern="code" />)
  })
  try {
    const { ids, fills } = patternWiring(document)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(fills.filter((f) => !f.resolves || !f.sameSvg)).toEqual([])
  } finally {
    await act(async () => {
      secondRoot.unmount()
    })
    second.remove()
  }
})
