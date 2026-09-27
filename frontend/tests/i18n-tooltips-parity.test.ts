// The tooltip change's i18n: every new key exists in en and ru, the Russian is
// actually Russian (not a copy of the English), the shell's static
// "Toggle sidebar" label is gone from both locales and from the source, and
// the components really reference the new keys — a key nobody reads would
// pass the first three checks and still ship an untranslated tooltip.
//
// Same approach as tests/i18n-session-page-parity.test.ts: a missing ru key
// never fails loudly at runtime (i18next falls back to English), so this is
// the only place it would be caught.

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/** Each new key, and the one source file that has to reference it. */
const NEW_KEYS: [string, string][] = [
  ['tabs.addTooltip', 'app/tab-bar.tsx'],
  ['shell.hideSidebar', 'app/tab-bar.tsx'],
  ['shell.showSidebar', 'app/tab-bar.tsx'],
  ['sessions.dockerTooltip', 'features/sessions/components/session-page.tsx'],
  ['sessions.editorTooltip', 'features/sessions/components/session-page.tsx'],
  ['sessions.attachments.attachTooltip', 'features/sessions/components/composer.tsx'],
  ['sessions.stopTooltip', 'features/sessions/components/composer.tsx'],
  ['sessions.sendTooltip', 'features/sessions/components/composer.tsx'],
]

const SRC = join(import.meta.dir, '../src')
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function allSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      // Generated client: not app code, and never references i18n keys.
      if (name === 'generated') return []
      return allSourceFiles(full)
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

test('every new tooltip key is a non-empty string in en.json and ru.json', () => {
  const problems: string[] = []
  for (const [key] of NEW_KEYS) {
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const value = lookup(bundle, key)
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}:${key}`)
    }
  }
  expect(problems).toEqual([])
})

test('no ru value is a copy of the en one', () => {
  expect(NEW_KEYS.filter(([key]) => lookup(en, key) === lookup(ru, key)).map(([k]) => k)).toEqual(
    [],
  )
})

test('every ru value is written in Cyrillic', () => {
  expect(
    NEW_KEYS.filter(([key]) => !/[Ѐ-ӿ]/.test(String(lookup(ru, key)))).map(([k]) => k),
  ).toEqual([])
})

test('hide and show are different labels, in both locales', () => {
  expect(en.shell.hideSidebar).not.toBe(en.shell.showSidebar)
  expect(ru.shell.hideSidebar).not.toBe(ru.shell.showSidebar)
})

test('shell.toggleSidebar is removed from both locales', () => {
  expect(lookup(en, 'shell.toggleSidebar')).toBeUndefined()
  expect(lookup(ru, 'shell.toggleSidebar')).toBeUndefined()
})

test('nothing under src/ references shell.toggleSidebar any more', () => {
  // Matches the key, not the bare word: `toggleSidebar` is also the shadcn
  // sidebar context's own function (shared/ui/sidebar.tsx and its callers).
  const offenders = allSourceFiles(SRC).filter((f) =>
    readFileSync(f, 'utf8').includes('shell.toggleSidebar'),
  )
  expect(offenders).toEqual([])
})

test('each new key is actually referenced by the component that shows it', () => {
  const unreferenced = NEW_KEYS.filter(([key, file]) => !source(file).includes(`'${key}'`)).map(
    ([key, file]) => `${key} in ${file}`,
  )
  expect(unreferenced).toEqual([])
})

test("tabs.close's tooltip keeps the {{name}} interpolation in both locales", () => {
  expect(en.tabs.close).toContain('{{name}}')
  expect(ru.tabs.close).toContain('{{name}}')
})
