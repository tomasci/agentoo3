// The custom-background preference at the storage boundary
// (src/shared/store/ui.ts): `backgroundAtom` and `backgroundPatternAtom`, the
// id lists they validate against, and `isBackgroundActive` — plus
// `accentColorAtom` (its own key, `agentoo:accent-color`, over the same 18
// background ids), at the bottom of this file.
//
// The contract under test is the spec's, not the implementation's: both atoms
// default to 'none', a valid id written persists as its JSON string, and *any*
// stored value that is not a known id — invalid JSON, a number, an object, an
// unknown or wrong-case string, an id from the other atom's list, a prototype
// key — reads as 'none' and never throws. That holds on each of the three
// paths a raw stored value can reach a reader by:
//
//   1. `getOnInit`, when ui.ts is evaluated. jotai reads storage once, at atom
//      creation (`atom(getOnInit ? storage.getItem(...) : initial)`), so this
//      path is only reachable through a fresh evaluation of the module — the
//      `?fresh=N` import, same idiom as tests/markdown-field.test.tsx.
//   2. `onMount`, which re-reads storage the first time a store subscribes.
//   3. The cross-tab `storage` event subscription, simulated the way
//      tests/workspace.test.tsx does: another window has already written
//      localStorage, and this one only learns of it from the event.
//
// Hermetic: localStorage is cleared before and after every case; nothing here
// renders.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  accentColorAtom,
  BACKGROUND_COLOR_IDS,
  BACKGROUND_GRADIENT_IDS,
  BACKGROUND_PATTERN_IDS,
  backgroundAtom,
  backgroundPatternAtom,
  isBackgroundActive,
} from '../src/shared/store/ui'

const BG_KEY = 'agentoo:background'
const PATTERN_KEY = 'agentoo:background-pattern'
const ACCENT_KEY = 'agentoo:accent-color'

// Spelled out from the spec rather than imported, so a renamed, dropped or
// reordered id in ui.ts fails here instead of agreeing with itself.
const COLORS = [
  'red', 'orange', 'yellow', 'green', 'mint', 'teal',
  'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const
const GRADIENTS = ['sunset', 'ocean', 'forest', 'lavender', 'peach'] as const
const PATTERNS = ['code', 'space', 'nature', 'weather', 'doodles', 'geometric'] as const
const BACKGROUNDS = [...COLORS, ...GRADIENTS] as const

/** Raw localStorage strings that are not a known id for *either* atom. */
const GARBAGE: ReadonlyArray<readonly [string, string]> = [
  ['invalid JSON', '{not json'],
  ['a bare unquoted id (not JSON)', 'blue'],
  ['an empty string', ''],
  ['a JSON number', '42'],
  ['JSON null', 'null'],
  ['JSON true', 'true'],
  ['a JSON object', '{"id":"blue"}'],
  ['a JSON array', '["blue"]'],
  ['an unknown id', '"magenta"'],
  ['a wrong-case id', '"Blue"'],
  ['an id with whitespace', '" none"'],
  ['the empty JSON string', '""'],
  ['__proto__', '"__proto__"'],
  ['constructor', '"constructor"'],
  ['toString', '"toString"'],
  ['hasOwnProperty', '"hasOwnProperty"'],
]

/** Valid for one atom, garbage for the other. */
const CROSS_LIST: ReadonlyArray<readonly [string, string, string]> = [
  [BG_KEY, '"code"', 'a pattern id stored as the background'],
  [BG_KEY, '"geometric"', 'a pattern id stored as the background'],
  [PATTERN_KEY, '"blue"', 'a colour id stored as the pattern'],
  [PATTERN_KEY, '"sunset"', 'a gradient id stored as the pattern'],
]

let fresh = 0
async function freshModule() {
  const mod = await import(`../src/shared/store/ui.ts?appearance-fresh=${++fresh}`)
  return {
    backgroundAtom: mod.backgroundAtom as typeof backgroundAtom,
    backgroundPatternAtom: mod.backgroundPatternAtom as typeof backgroundPatternAtom,
    accentColorAtom: mod.accentColorAtom as typeof accentColorAtom,
  }
}

/** What another same-origin window does: write storage, then raise the event
 *  only *other* windows receive. `newValue: null` is a removal. */
function otherWindowWrites(key: string, newValue: string | null) {
  const oldValue = localStorage.getItem(key)
  if (newValue === null) localStorage.removeItem(key)
  else localStorage.setItem(key, newValue)
  window.dispatchEvent(
    new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }),
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

// --- the id lists ---------------------------------------------------------------

test('the exported id lists are exactly the spec ids, in display order', () => {
  expect([...BACKGROUND_COLOR_IDS]).toEqual([...COLORS])
  expect([...BACKGROUND_GRADIENT_IDS]).toEqual([...GRADIENTS])
  expect([...BACKGROUND_PATTERN_IDS]).toEqual([...PATTERNS])
})

// --- isBackgroundActive -----------------------------------------------------------

describe('isBackgroundActive', () => {
  test('is false only when both are none', () => {
    expect(isBackgroundActive('none', 'none')).toBe(false)
  })

  test('is true for every background over no pattern', () => {
    const inactive = BACKGROUNDS.filter((bg) => !isBackgroundActive(bg, 'none'))
    expect(inactive).toEqual([])
  })

  test('is true for every pattern over no background (a pattern alone is still active)', () => {
    const inactive = PATTERNS.filter((p) => !isBackgroundActive('none', p))
    expect(inactive).toEqual([])
  })

  test('is true when both are chosen', () => {
    expect(isBackgroundActive('sunset', 'space')).toBe(true)
    expect(isBackgroundActive('brown', 'geometric')).toBe(true)
  })
})

// --- defaults and writes ------------------------------------------------------------

test('with nothing stored, both atoms read none', () => {
  const store = createStore()
  expect(store.get(backgroundAtom)).toBe('none')
  expect(store.get(backgroundPatternAtom)).toBe('none')
})

test('with nothing stored, a fresh module evaluation starts both at none', async () => {
  const mod = await freshModule()
  const store = createStore()
  expect(store.get(mod.backgroundAtom)).toBe('none')
  expect(store.get(mod.backgroundPatternAtom)).toBe('none')
})

test('writing every background id persists its JSON string under agentoo:background', () => {
  const store = createStore()
  const wrong: string[] = []
  for (const id of BACKGROUNDS) {
    store.set(backgroundAtom, id)
    if (store.get(backgroundAtom) !== id) wrong.push(`atom:${id}`)
    if (localStorage.getItem(BG_KEY) !== JSON.stringify(id)) wrong.push(`storage:${id}`)
  }
  expect(wrong).toEqual([])
  // And nothing leaked into the other key.
  expect(localStorage.getItem(PATTERN_KEY)).toBeNull()
})

test('writing every pattern id persists its JSON string under agentoo:background-pattern', () => {
  const store = createStore()
  const wrong: string[] = []
  for (const id of PATTERNS) {
    store.set(backgroundPatternAtom, id)
    if (store.get(backgroundPatternAtom) !== id) wrong.push(`atom:${id}`)
    if (localStorage.getItem(PATTERN_KEY) !== JSON.stringify(id)) wrong.push(`storage:${id}`)
  }
  expect(wrong).toEqual([])
  expect(localStorage.getItem(BG_KEY)).toBeNull()
})

test('writing none back after a choice reads none, from this store and a fresh one', async () => {
  const store = createStore()
  store.set(backgroundAtom, 'teal')
  store.set(backgroundPatternAtom, 'nature')
  store.set(backgroundAtom, 'none')
  store.set(backgroundPatternAtom, 'none')
  expect(store.get(backgroundAtom)).toBe('none')
  expect(store.get(backgroundPatternAtom)).toBe('none')
  const mod = await freshModule()
  expect(createStore().get(mod.backgroundAtom)).toBe('none')
  expect(createStore().get(mod.backgroundPatternAtom)).toBe('none')
})

// --- path 1: getOnInit ------------------------------------------------------------

describe('getOnInit: a fresh module evaluation reads the stored value synchronously', () => {
  test('every valid background id round-trips', async () => {
    const wrong: string[] = []
    for (const id of BACKGROUNDS) {
      localStorage.setItem(BG_KEY, JSON.stringify(id))
      const mod = await freshModule()
      const got = createStore().get(mod.backgroundAtom)
      if (got !== id) wrong.push(`${id} -> ${got}`)
    }
    expect(wrong).toEqual([])
  })

  test('every valid pattern id round-trips', async () => {
    const wrong: string[] = []
    for (const id of PATTERNS) {
      localStorage.setItem(PATTERN_KEY, JSON.stringify(id))
      const mod = await freshModule()
      const got = createStore().get(mod.backgroundPatternAtom)
      if (got !== id) wrong.push(`${id} -> ${got}`)
    }
    expect(wrong).toEqual([])
  })

  for (const [what, raw] of GARBAGE) {
    test(`${what} (${JSON.stringify(raw)}) in both keys reads none and does not throw`, async () => {
      localStorage.setItem(BG_KEY, raw)
      localStorage.setItem(PATTERN_KEY, raw)
      const mod = await freshModule()
      const store = createStore()
      expect(store.get(mod.backgroundAtom)).toBe('none')
      expect(store.get(mod.backgroundPatternAtom)).toBe('none')
    })
  }

  for (const [key, raw, what] of CROSS_LIST) {
    test(`${what} (${raw}) reads none`, async () => {
      localStorage.setItem(key, raw)
      const mod = await freshModule()
      const atom = key === BG_KEY ? mod.backgroundAtom : mod.backgroundPatternAtom
      expect(createStore().get(atom as typeof backgroundAtom)).toBe('none')
    })
  }
})

// --- path 2: onMount ---------------------------------------------------------------

describe('onMount: the re-read on first subscription', () => {
  test('a valid value stored after module evaluation is picked up on mount', () => {
    localStorage.setItem(BG_KEY, '"ocean"')
    localStorage.setItem(PATTERN_KEY, '"weather"')
    const store = createStore()
    const unsubs = [store.sub(backgroundAtom, () => {}), store.sub(backgroundPatternAtom, () => {})]
    expect(store.get(backgroundAtom)).toBe('ocean')
    expect(store.get(backgroundPatternAtom)).toBe('weather')
    for (const u of unsubs) u()
  })

  for (const [what, raw] of GARBAGE) {
    test(`${what} (${JSON.stringify(raw)}) reads none on mount and does not throw`, () => {
      localStorage.setItem(BG_KEY, raw)
      localStorage.setItem(PATTERN_KEY, raw)
      const store = createStore()
      const unsubs = [
        store.sub(backgroundAtom, () => {}),
        store.sub(backgroundPatternAtom, () => {}),
      ]
      expect(store.get(backgroundAtom)).toBe('none')
      expect(store.get(backgroundPatternAtom)).toBe('none')
      for (const u of unsubs) u()
    })
  }
})

// --- path 3: the cross-tab storage event -------------------------------------------

describe('cross-tab: a storage event from another window', () => {
  test('a valid background id from another window is adopted', () => {
    const store = createStore()
    const unsub = store.sub(backgroundAtom, () => {})
    otherWindowWrites(BG_KEY, '"lavender"')
    expect(store.get(backgroundAtom)).toBe('lavender')
    unsub()
  })

  test('a valid pattern id from another window is adopted', () => {
    const store = createStore()
    const unsub = store.sub(backgroundPatternAtom, () => {})
    otherWindowWrites(PATTERN_KEY, '"doodles"')
    expect(store.get(backgroundPatternAtom)).toBe('doodles')
    unsub()
  })

  for (const [what, raw] of [...GARBAGE, ['a removed key', null] as const]) {
    test(`${what} replaces a valid choice with none, without throwing`, () => {
      const store = createStore()
      const unsubs = [
        store.sub(backgroundAtom, () => {}),
        store.sub(backgroundPatternAtom, () => {}),
      ]
      store.set(backgroundAtom, 'blue')
      store.set(backgroundPatternAtom, 'space')

      otherWindowWrites(BG_KEY, raw)
      otherWindowWrites(PATTERN_KEY, raw)

      expect(store.get(backgroundAtom)).toBe('none')
      expect(store.get(backgroundPatternAtom)).toBe('none')
      for (const u of unsubs) u()
    })
  }

  for (const [key, raw, what] of CROSS_LIST) {
    test(`${what} (${raw}) from another window reads none`, () => {
      const store = createStore()
      const atom = key === BG_KEY ? backgroundAtom : backgroundPatternAtom
      const unsub = store.sub(atom, () => {})
      if (key === BG_KEY) store.set(backgroundAtom, 'red')
      else store.set(backgroundPatternAtom, 'code')
      otherWindowWrites(key, raw)
      expect(store.get(atom)).toBe('none')
      unsub()
    })
  }

  test('an event for some other key leaves both choices alone', () => {
    const store = createStore()
    const unsubs = [store.sub(backgroundAtom, () => {}), store.sub(backgroundPatternAtom, () => {})]
    store.set(backgroundAtom, 'mint')
    store.set(backgroundPatternAtom, 'nature')
    otherWindowWrites('agentoo:theme', '"light"')
    expect(store.get(backgroundAtom)).toBe('mint')
    expect(store.get(backgroundPatternAtom)).toBe('nature')
    for (const u of unsubs) u()
  })
})

// --- accentColorAtom ----------------------------------------------------------------
//
// Same ids as the background ('none' + 12 colours + 5 gradients), same
// validation, its own key — and neither atom ever reads or writes the other's.

describe('accentColorAtom', () => {
  const ACCENT_IDS = ['none', ...BACKGROUNDS] as const

  test('with nothing stored it reads none, from this module and a fresh evaluation', async () => {
    expect(createStore().get(accentColorAtom)).toBe('none')
    const mod = await freshModule()
    expect(createStore().get(mod.accentColorAtom)).toBe('none')
  })

  test('writing each of the 18 ids persists its JSON string under agentoo:accent-color', () => {
    expect(ACCENT_IDS).toHaveLength(18)
    const store = createStore()
    const wrong: string[] = []
    for (const id of ACCENT_IDS) {
      store.set(accentColorAtom, id)
      if (store.get(accentColorAtom) !== id) wrong.push(`atom:${id}`)
      if (localStorage.getItem(ACCENT_KEY) !== JSON.stringify(id)) wrong.push(`storage:${id}`)
    }
    expect(wrong).toEqual([])
  })

  test('getOnInit: each of the 18 ids round-trips through a fresh module evaluation', async () => {
    const wrong: string[] = []
    for (const id of ACCENT_IDS) {
      localStorage.setItem(ACCENT_KEY, JSON.stringify(id))
      const mod = await freshModule()
      const got = createStore().get(mod.accentColorAtom)
      if (got !== id) wrong.push(`${id} -> ${got}`)
    }
    expect(wrong).toEqual([])
  })

  const BAD: ReadonlyArray<readonly [string, string]> = [
    ...GARBAGE,
    ['a pattern id', '"code"'],
    ['another pattern id', '"geometric"'],
  ]

  for (const [what, raw] of BAD) {
    test(`getOnInit: ${what} (${JSON.stringify(raw)}) reads none and does not throw`, async () => {
      localStorage.setItem(ACCENT_KEY, raw)
      const mod = await freshModule()
      expect(createStore().get(mod.accentColorAtom)).toBe('none')
    })

    test(`onMount: ${what} (${JSON.stringify(raw)}) reads none and does not throw`, () => {
      localStorage.setItem(ACCENT_KEY, raw)
      const store = createStore()
      const unsub = store.sub(accentColorAtom, () => {})
      expect(store.get(accentColorAtom)).toBe('none')
      unsub()
    })

    test(`cross-tab: ${what} (${JSON.stringify(raw)}) replaces a valid accent with none`, () => {
      const store = createStore()
      const unsub = store.sub(accentColorAtom, () => {})
      store.set(accentColorAtom, 'purple')
      otherWindowWrites(ACCENT_KEY, raw)
      expect(store.get(accentColorAtom)).toBe('none')
      unsub()
    })
  }

  test('cross-tab: a valid accent from another window is adopted', () => {
    const store = createStore()
    const unsub = store.sub(accentColorAtom, () => {})
    otherWindowWrites(ACCENT_KEY, '"ocean"')
    expect(store.get(accentColorAtom)).toBe('ocean')
    unsub()
  })

  test('writing the accent never touches agentoo:background, and vice versa', () => {
    const store = createStore()
    store.set(accentColorAtom, 'blue')
    expect(localStorage.getItem(BG_KEY)).toBeNull()
    expect(localStorage.getItem(PATTERN_KEY)).toBeNull()
    expect(store.get(backgroundAtom)).toBe('none')

    store.set(backgroundAtom, 'red')
    expect(localStorage.getItem(ACCENT_KEY)).toBe('"blue"')
    expect(store.get(accentColorAtom)).toBe('blue')

    store.set(accentColorAtom, 'none')
    expect(localStorage.getItem(BG_KEY)).toBe('"red"')
    expect(store.get(backgroundAtom)).toBe('red')
  })

  test('a stored background is not read as the accent, and a stored accent is not read as the background', async () => {
    localStorage.setItem(BG_KEY, '"teal"')
    let mod = await freshModule()
    expect(createStore().get(mod.accentColorAtom)).toBe('none')

    localStorage.clear()
    localStorage.setItem(ACCENT_KEY, '"teal"')
    mod = await freshModule()
    expect(createStore().get(mod.backgroundAtom)).toBe('none')
    expect(createStore().get(mod.accentColorAtom)).toBe('teal')
  })

  test('a cross-tab background change leaves the accent alone, and vice versa', () => {
    const store = createStore()
    const unsubs = [store.sub(accentColorAtom, () => {}), store.sub(backgroundAtom, () => {})]
    store.set(accentColorAtom, 'pink')
    store.set(backgroundAtom, 'mint')
    otherWindowWrites(BG_KEY, '"forest"')
    expect(store.get(accentColorAtom)).toBe('pink')
    otherWindowWrites(ACCENT_KEY, '"brown"')
    expect(store.get(backgroundAtom)).toBe('forest')
    expect(store.get(accentColorAtom)).toBe('brown')
    for (const u of unsubs) u()
  })
})
