// The strings `GitIdentityCard` (project-overview.tsx's "Git identity" card)
// and its form schema added under `projects.gitIdentity`: every one exists in
// both en.json and ru.json, the whole block has exactly the same keys in
// both locales, the `{{name}}`/`{{email}}` placeholders line up, the client-
// side schema's error keys resolve to real strings, the ru copy is actually
// Russian and not a copy of the English, and the card references every key.
// Modelled on tests/i18n-settings-parity.test.ts.
//
// A missing `ru` key does not fail loudly — i18next falls back to English —
// see tests/i18n-transcript-parity.test.ts.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const lookup = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, part) =>
      node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root,
  )

const leaves = (node: unknown, prefix = ''): string[] =>
  node !== null && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, prefix ? `${prefix}.${k}` : k),
      )
    : [prefix]

const NEW_KEYS = [
  'projects.gitIdentity.heading',
  'projects.gitIdentity.explain',
  'projects.gitIdentity.configPathLead',
  'projects.gitIdentity.name',
  'projects.gitIdentity.email',
  'projects.gitIdentity.clear',
  'projects.gitIdentity.saved',
  'projects.gitIdentity.saveFailed',
  'projects.gitIdentity.cleared',
  'projects.gitIdentity.clearFailed',
  'projects.gitIdentity.loadFailed',
  'projects.gitIdentity.unavailable',
  'projects.gitIdentity.statusSet',
  'projects.gitIdentity.statusEffective',
  'projects.gitIdentity.statusPartial',
  'projects.gitIdentity.statusMissing',
  'projects.gitIdentity.errors.nameRequired',
  'projects.gitIdentity.errors.nameTooLong',
  'projects.gitIdentity.errors.nameInvalid',
  'projects.gitIdentity.errors.emailRequired',
  'projects.gitIdentity.errors.emailTooLong',
  'projects.gitIdentity.errors.emailInvalid',
] as const

/** `{{name}}` placeholders in a string, sorted. */
const placeholders = (value: unknown) =>
  [...String(value).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()

test('every new key is a non-empty string in en.json and ru.json', () => {
  const missing: string[] = []
  for (const key of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}:${key}`)
    }
  }
  expect(missing).toEqual([])
})

test('the whole projects.gitIdentity block has exactly the same keys in both locales', () => {
  expect(leaves(lookup(ru, 'projects.gitIdentity')).sort()).toEqual(
    leaves(lookup(en, 'projects.gitIdentity')).sort(),
  )
})

test('every gitIdentity string carries the same interpolation placeholders in both locales', () => {
  const mismatched = leaves(lookup(en, 'projects.gitIdentity'))
    .map((k) => `projects.gitIdentity.${k}`)
    .filter((key) => placeholders(lookup(en, key)).join() !== placeholders(lookup(ru, key)).join())
  expect(mismatched).toEqual([])
})

test('the three status lines that name an identity interpolate {{name}} and {{email}} in both locales', () => {
  for (const key of [
    'projects.gitIdentity.statusSet',
    'projects.gitIdentity.statusEffective',
    'projects.gitIdentity.statusPartial',
  ]) {
    expect(placeholders(lookup(en, key))).toEqual(['email', 'name'])
    expect(placeholders(lookup(ru, key))).toEqual(['email', 'name'])
  }
})

test('ru values are not copies of the en ones, and are written in Cyrillic', () => {
  // "Email" itself is kept identical in both locales on purpose — the same
  // Latin-loanword convention the ru bundle already uses for "SSH-ключ" (a
  // borrowed term, not an untranslated one) — so it is exempt from both
  // halves of this check.
  const borrowedTerm = new Set(['projects.gitIdentity.email'])
  const checked = NEW_KEYS.filter((key) => !borrowedTerm.has(key))
  const copied = checked.filter((key) => lookup(en, key) === lookup(ru, key))
  const latinOnly = checked.filter((key) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key))))
  expect({ copied, latinOnly }).toEqual({ copied: [], latinOnly: [] })
})

test("every message key the git identity form schema can raise resolves to a string in both locales", async () => {
  const schema = await Bun.file(
    new URL('../src/features/projects/model/git-identity-form.schema.ts', import.meta.url),
  ).text()
  const keys = [...new Set([...schema.matchAll(/'(projects\.gitIdentity\.errors\.[\w.]+)'/g)].map((m) => m[1]))]
  expect(keys.length).toBeGreaterThan(0)
  const unresolved = keys.filter(
    (key) => typeof lookup(en, key as string) !== 'string' || typeof lookup(ru, key as string) !== 'string',
  )
  expect(unresolved).toEqual([])
})

test('the card or its form schema references every new key', async () => {
  const card = await Bun.file(
    new URL('../src/features/projects/components/git-identity-card.tsx', import.meta.url),
  ).text()
  const schema = await Bun.file(
    new URL('../src/features/projects/model/git-identity-form.schema.ts', import.meta.url),
  ).text()
  // An error key is never written out literally in the card — it only ever
  // reaches `t()` indirectly, as the `.message` zodResolver already attached
  // to the field (see the card's own `nameError`/`emailError`) — so the
  // schema, where every one of those messages *is* written out literally, is
  // searched too.
  const unreferenced = NEW_KEYS.filter(
    (key) => !card.includes(`'${key}'`) && !schema.includes(`'${key}'`),
  )
  expect(unreferenced).toEqual([])
})
