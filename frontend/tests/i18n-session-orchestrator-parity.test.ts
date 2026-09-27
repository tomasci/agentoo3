// The orchestrator-required change's copy: the two keys it added exist in
// both locales (Russian actually translated), the two it removed are gone
// from both, and nothing in src/ still asks for a removed one — i18next
// would silently render the bare key for it.
//
// `ideas.form.orchestratorNone` is a different, still-used key (ideas keep
// an optional orchestrator); only the fully-qualified session keys are
// checked here.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      root,
    )

const ADDED = [
  'sessions.form.orchestratorPlaceholder',
  'sessions.form.orchestratorRequired',
] as const
const REMOVED = ['sessions.needsOrchestrator', 'sessions.form.orchestratorNone'] as const
const BUNDLES = [
  ['en', en],
  ['ru', ru],
] as const

test('each added key is a non-empty string in en.json and ru.json', () => {
  const problems: string[] = []
  for (const key of ADDED) {
    for (const [locale, bundle] of BUNDLES) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}:${key}`)
    }
  }
  expect(problems).toEqual([])
})

test('the Russian copy of each added key is Cyrillic, not the English copied over', () => {
  const rows = ADDED.map((key) => ({
    key,
    copied: lookup(en, key) === lookup(ru, key),
    cyrillic: /[Ѐ-ӿ]/.test(String(lookup(ru, key))),
    latin: /[A-Za-z]/.test(String(lookup(ru, key))),
  }))
  expect(rows).toEqual(ADDED.map((key) => ({ key, copied: false, cyrillic: true, latin: false })))
})

test('each removed key is absent from both en.json and ru.json', () => {
  const present = REMOVED.flatMap((key) =>
    BUNDLES.filter(([, bundle]) => lookup(bundle, key) !== undefined).map(([l]) => `${l}:${key}`),
  )
  expect(present).toEqual([])
})

test('nothing under src/ references a removed key', () => {
  const src = join(import.meta.dir, '../src')
  const hits: string[] = []
  for (const file of new Glob('**/*.{ts,tsx}').scanSync({ cwd: src })) {
    if (file.startsWith('shared/api/generated/')) continue
    const text = readFileSync(join(src, file), 'utf8')
    for (const key of REMOVED) if (text.includes(key)) hits.push(`${file}: ${key}`)
    // The last path segment alone, in case it is built as `sessions.${…}`.
    if (/['"`.]needsOrchestrator['"`]/.test(text)) hits.push(`${file}: needsOrchestrator`)
  }
  expect(hits).toEqual([])
})

test('the dialog source actually uses both added keys', () => {
  const text = readFileSync(
    join(import.meta.dir, '../src/features/sessions/components/new-session-dialog.tsx'),
    'utf8',
  )
  expect(ADDED.filter((key) => !text.includes(`'${key}'`))).toEqual([])
})
