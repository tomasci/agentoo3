// Every key the transcript actually asks for, in both locale files.
//
// A missing `ru` key does not fail loudly: i18next falls back to the English
// string, so the Russian UI quietly grows an English label and nothing here
// or in CI notices. tests/i18n-ideas-parity.test.ts made that check for the
// `ideas` block; this does the same for the transcript, and additionally
// pins the keys to the component that references them — parity between two
// files is worth nothing if both are missing the key the code uses.
//
// Scoped deliberately to `sessions.transcript` (plus whatever
// transcript.tsx names outside it) rather than to the whole file: other
// blocks are other people's tracks, and a half-finished one elsewhere should
// not fail this.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const SOURCE = new URL('../src/features/sessions/components/transcript.tsx', import.meta.url)
const source = await Bun.file(SOURCE).text()

/** Every `t('…')` literal in the component, deduped. Dynamic keys would not
 * be caught by this, so the test also asserts there are none. */
const referenced = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1] as string)
const unique = [...new Set(referenced)].sort()

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Resolve a dot path, tolerating the CLDR plural suffixes en and ru use
 * different numbers of — see the long note in i18n-ideas-parity.test.ts. */
function lookup(root: unknown, path: string): string | undefined {
  const parts = path.split('.')
  const last = parts.pop() as string
  let node: unknown = root
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  if (node === null || typeof node !== 'object') return undefined
  const bag = node as Record<string, unknown>
  const direct = bag[last]
  if (typeof direct === 'string') return direct
  const plural = Object.entries(bag).find(
    ([k, v]) => typeof v === 'string' && k.replace(PLURAL_SUFFIX, '') === last && k !== last,
  )
  return plural?.[1] as string | undefined
}

test('transcript.tsx names at least the keys this change added', () => {
  // A guard on the extraction itself: if the regex ever stops matching, every
  // assertion below would pass vacuously.
  expect(unique).toContain('sessions.transcript.model')
  expect(unique.length).toBeGreaterThan(5)
  // No template-literal keys, which the regex above could not see.
  expect(source).not.toMatch(/\bt\(\s*`/)
})

test('every key transcript.tsx uses exists in en.json and in ru.json', () => {
  const missing: { key: string; locale: string }[] = []
  for (const key of unique) {
    if (lookup(en, key) === undefined) missing.push({ key, locale: 'en' })
    if (lookup(ru, key) === undefined) missing.push({ key, locale: 'ru' })
  }
  expect(missing).toEqual([])
})

test('the model label keeps its interpolation placeholder in both locales', () => {
  // `t('sessions.transcript.model', { model })` — a translation that dropped
  // the placeholder would render a label naming no model at all, which is
  // worse than no label.
  for (const [name, bundle] of [
    ['en', en],
    ['ru', ru],
  ] as const) {
    const value = lookup(bundle, 'sessions.transcript.model')
    expect({ name, value: typeof value }).toEqual({ name, value: 'string' })
    expect({ name, hasPlaceholder: (value ?? '').includes('{{model}}') }).toEqual({
      name,
      hasPlaceholder: true,
    })
    // And it is actually translated, not the English string pasted across.
    expect({ name, blank: (value ?? '').trim() === '' }).toEqual({ name, blank: false })
  }
})

test('the ru transcript block has every key the en one does, and vice versa', () => {
  const paths = (root: unknown): Set<string> => {
    const out = new Set<string>()
    const walk = (node: unknown, prefix: string) => {
      if (node === null || typeof node !== 'object') {
        out.add(prefix.replace(PLURAL_SUFFIX, ''))
        return
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k)
      }
    }
    walk(root, '')
    return out
  }

  const enBlock = (en as { sessions?: { transcript?: unknown } }).sessions?.transcript
  const ruBlock = (ru as { sessions?: { transcript?: unknown } }).sessions?.transcript
  expect(enBlock).toBeDefined()
  expect(ruBlock).toBeDefined()

  const enKeys = paths(enBlock)
  const ruKeys = paths(ruBlock)
  expect([...enKeys].filter((k) => !ruKeys.has(k)).sort()).toEqual([])
  expect([...ruKeys].filter((k) => !enKeys.has(k)).sort()).toEqual([])
})
