// The locale side of moving "Reconnecting…" from the session header into the
// status bar: `health.reconnecting` is new (and really translated), and the
// three keys it replaced — health's old "down" label and the session header's
// "live"/"reconnecting" pair (see REMOVED) — are gone from both locales and
// from every source and test file, so nothing can still render one as a raw
// key.
//
// Same lookup idiom as tests/i18n-session-page-parity.test.ts.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const hasPath = (root: unknown, path: string): boolean => {
  const parts = path.split('.')
  const leaf = parts.pop() as string
  const parent = lookup(root, parts.join('.'))
  return parent !== null && typeof parent === 'object' && Object.hasOwn(parent, leaf)
}

// Built by concatenation so this file's own source never contains the literal
// keys the reference scan below looks for.
const REMOVED = [['health', 'down'], ['sessions', 'live'], ['sessions', 'reconnecting']].map(
  (p) => p.join('.'),
)

test('health.reconnecting is "Reconnecting…" in en', () => {
  expect(lookup(en, 'health.reconnecting')).toBe('Reconnecting…')
})

test('health.reconnecting in ru is a non-empty Cyrillic string, not a copy of en', () => {
  const value = lookup(ru, 'health.reconnecting')
  expect(typeof value).toBe('string')
  expect(String(value).trim()).not.toBe('')
  expect(/[Ѐ-ӿ]/.test(String(value))).toBe(true)
  expect(value).not.toBe(lookup(en, 'health.reconnecting'))
})

test('the removed keys exist in neither locale', () => {
  const present: string[] = []
  for (const key of REMOVED) {
    if (hasPath(en, key)) present.push(`en:${key}`)
    if (hasPath(ru, key)) present.push(`ru:${key}`)
  }
  expect(present).toEqual([])
})

test('the health namespace keeps the same key set in both locales', () => {
  const keysOf = (b: unknown) => Object.keys(lookup(b, 'health') as object).sort()
  expect(keysOf(ru)).toEqual(keysOf(en))
  expect(keysOf(en)).toContain('reconnecting')
  expect(keysOf(en)).toContain('checking')
  expect(keysOf(en)).toContain('ok')
  expect(keysOf(en)).toContain('noCredential')
})

async function filesUnder(dir: string) {
  const base = new URL(`../${dir}/`, import.meta.url).pathname
  const out: string[] = []
  for await (const rel of new Bun.Glob('**/*.{ts,tsx,json}').scan({ cwd: base })) {
    if (rel.includes('/generated/')) continue
    out.push(`${base}${rel}`)
  }
  return out
}

test('no file under src/ references a removed key', async () => {
  const hits: string[] = []
  for (const file of await filesUnder('src')) {
    const text = await Bun.file(file).text()
    for (const key of REMOVED) if (text.includes(key)) hits.push(`${file}: ${key}`)
  }
  expect(hits).toEqual([])
})

test('under tests/, a removed key only ever appears inside a negative assertion', async () => {
  const hits: string[] = []
  for (const file of await filesUnder('tests')) {
    const lines = (await Bun.file(file).text()).split('\n')
    lines.forEach((line, i) => {
      for (const key of REMOVED) {
        if (line.includes(key) && !/\.not\.to/.test(line)) hits.push(`${file}:${i + 1}: ${key}`)
      }
    })
  }
  expect(hits).toEqual([])
})
