// Same idea as tests/i18n-ideas-parity.test.ts, scoped to the two places this
// track added copy: the top-level `editor` block, and `sessions.editor` (the
// session header's link label, sitting right next to `sessions.docker`).
//
// A plain string-set diff is the wrong notion of parity for a pluralised key
// — see i18n-ideas-parity.test.ts's own comment on why a CLDR plural suffix is
// stripped before either language's key set is built. `editor.idleNote` is
// this file's own instance: English resolves it with `_one`/`_other`, Russian
// with `_one`/`_few`/`_many`, and a literal-suffix comparison would flag that
// difference as broken when it is not.

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Every leaf key path under `root`, dot-joined, with a trailing CLDR plural
 *  category stripped — see the header comment above. */
function keyPaths(root: unknown): Set<string> {
  const paths = new Set<string>()
  const walk = (node: unknown, prefix: string) => {
    if (node === null || typeof node !== 'object') {
      paths.add(prefix.replace(PLURAL_SUFFIX, ''))
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, prefix ? `${prefix}.${key}` : key)
    }
  }
  walk(root, '')
  return paths
}

test('every "editor" key in en.json has a matching one in ru.json, and vice versa', () => {
  const enEditor = (en as { editor?: unknown }).editor
  const ruEditor = (ru as { editor?: unknown }).editor
  expect(enEditor).toBeDefined()
  expect(ruEditor).toBeDefined()

  const enKeys = keyPaths(enEditor)
  const ruKeys = keyPaths(ruEditor)

  expect([...enKeys].filter((k) => !ruKeys.has(k)).sort()).toEqual([])
  expect([...ruKeys].filter((k) => !enKeys.has(k)).sort()).toEqual([])
})

test('"sessions.editor" — the header link label — exists in both languages', () => {
  const enSessions = (en as { sessions?: { editor?: unknown } }).sessions
  const ruSessions = (ru as { sessions?: { editor?: unknown } }).sessions

  expect(typeof enSessions?.editor).toBe('string')
  expect(typeof ruSessions?.editor).toBe('string')
})
