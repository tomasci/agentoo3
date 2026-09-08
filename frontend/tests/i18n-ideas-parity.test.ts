// There is no i18n parity test in this repo yet (a missing `ru` key falls
// back silently to English) — this is the first one, scoped to the one block
// this track owns, per its brief.
//
// A plain string-set diff is the wrong notion of parity for a pluralised key:
// i18next resolves `<base>_<category>` against `Intl.PluralRules`, and
// English (`one`/`other`) and Russian (`one`/`few`/`many`) need a different
// *number* of categories for the same concept — this file's own
// `sessions.pendingPrompts_one`/`_other` (English, 2 categories) versus
// `pendingPrompts_one`/`_few`/`_many` (Russian, 3) is the existing precedent
// for that, and a literal-suffix comparison would flag it as broken when it
// is not. So a recognised CLDR plural suffix is stripped down to its base
// name before either language's key set is built, and what gets compared is
// "does every pluralised concept exist in both languages", not "do they use
// the same suffixes to say so".

import { expect, test } from 'bun:test'
import en from '../src/shared/i18n/locales/en.json'
import ru from '../src/shared/i18n/locales/ru.json'

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Every leaf key path under `obj.ideas`, dot-joined, with a trailing CLDR
 * plural category stripped — `board.blocks_other` and `board.blocks_many`
 * both collapse to `board.blocks`, so the two languages' different plural
 * category counts (see the comment above) never register as a mismatch. */
function ideaKeyPaths(root: unknown): Set<string> {
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

test('every "ideas" key in en.json has a matching one in ru.json, and vice versa', () => {
  const enIdeas = (en as { ideas?: unknown }).ideas
  const ruIdeas = (ru as { ideas?: unknown }).ideas
  expect(enIdeas).toBeDefined()
  expect(ruIdeas).toBeDefined()

  const enKeys = ideaKeyPaths(enIdeas)
  const ruKeys = ideaKeyPaths(ruIdeas)

  const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k)).sort()
  const missingInEn = [...ruKeys].filter((k) => !enKeys.has(k)).sort()

  expect(missingInRu).toEqual([])
  expect(missingInEn).toEqual([])
})
