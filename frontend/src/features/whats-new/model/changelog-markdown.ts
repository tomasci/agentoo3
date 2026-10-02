import type { ChangeKind } from './changelog.schema'

// Turns CHANGELOG.md / CHANGELOG.ru.md (repo root) into the same shape
// changelog.schema.ts validates, so vite.config.ts can `define` __CHANGELOG__
// from the real files and tests/setup.ts can seed the same global from the
// same source. Deliberately dependency-free (no zod, no `@/` alias):
// vite.config.ts imports this module at config-*load* time, before plugins
// (and therefore `resolve.alias`) exist, so a `@/...` specifier would fail to
// resolve there even though it resolves fine from ordinary app code.
//
// Strict on purpose — a malformed changelog is a build failure
// (frontend/README.md's "Adding a changelog entry"), not a silently-dropped
// line: every error below names the offending file and line number, the way
// a compiler would, rather than a generic "invalid changelog".

const KIND_ORDER: readonly ChangeKind[] = ['new', 'improved', 'fixed']

const KIND_HEADINGS: Record<'en' | 'ru', Record<string, ChangeKind>> = {
  en: { New: 'new', Improved: 'improved', Fixed: 'fixed' },
  ru: { Новое: 'new', Улучшено: 'improved', Исправлено: 'fixed' },
}

const RELEASE_HEADING = /^## +(\S+) +[-–—] +(\d{4}-\d{2}-\d{2}) *$/
const VERSION = /^\d+(\.\d+)*$/
const BULLET = /^- (.+)$/

export interface ParsedChange {
  kind: ChangeKind
  /** One kind section's bullets, in file order. */
  lines: string[]
}

export interface ParsedRelease {
  version: string
  date: string
  /** Only the kinds this release actually has, already in `new, improved,
   *  fixed` order — enforced while parsing, not sorted afterwards. */
  changes: ParsedChange[]
}

function totalBullets(release: ParsedRelease): number {
  return release.changes.reduce((n, c) => n + c.lines.length, 0)
}

/**
 * Parses one changelog file. `language` picks which localized kind headings
 * (`### New`/`### Improved`/`### Fixed` vs `### Новое`/`### Улучшено`/
 * `### Исправлено`) are legal in it; `fileLabel` (e.g. "CHANGELOG.md") is
 * only ever used to name this file in a thrown error.
 *
 * Text before the first `## ` release heading is a free-form intro (title,
 * explanation, cross-link to the other language) and is ignored entirely —
 * everything after it is load-bearing.
 */
export function parseChangelogMarkdown(
  text: string,
  language: 'en' | 'ru',
  fileLabel: string,
): ParsedRelease[] {
  const headings = KIND_HEADINGS[language]
  const releases: ParsedRelease[] = []
  const seenVersions = new Set<string>()

  let current: ParsedRelease | null = null
  let currentKind: ChangeKind | null = null

  // A `function` declaration, not a `const` arrow — only a hoisted function
  // declaration's `never` return type actually narrows the caller's control
  // flow afterwards (an arrow assigned to a `const` carries the same type
  // but TS does not special-case it the same way), and every `if (bad) fail(…)`
  // below relies on that narrowing to avoid a `noUncheckedIndexedAccess`-style
  // fight with values this function has already ruled out.
  function fail(line: number, message: string): never {
    throw new Error(`${fileLabel}:${line}: ${message}`)
  }

  function finishRelease(line: number) {
    if (current === null) return
    if (totalBullets(current) === 0) {
      fail(line, `release ${current.version} has no changes under any kind heading`)
    }
    releases.push(current)
  }

  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1

    if (line.startsWith('## ')) {
      finishRelease(lineNo)
      const match = RELEASE_HEADING.exec(line)
      if (!match) {
        fail(
          lineNo,
          `malformed release heading ${JSON.stringify(line)} — expected "## <version> — <YYYY-MM-DD>"`,
        )
      }
      const [, version, date] = match
      if (version === undefined || date === undefined) {
        fail(lineNo, `malformed release heading ${JSON.stringify(line)} — missing a capture group`)
      }
      if (!VERSION.test(version)) {
        fail(lineNo, `"${version}" is not a dotted numeric version (e.g. "1.2.150")`)
      }
      if (seenVersions.has(version)) {
        fail(lineNo, `duplicate release ${version}`)
      }
      seenVersions.add(version)
      current = { version, date, changes: [] }
      currentKind = null
      continue
    }

    if (current === null) continue // still in the free-form intro

    if (line.startsWith('### ')) {
      const heading = line.slice(4).trim()
      const kind = headings[heading]
      if (kind === undefined) {
        fail(
          lineNo,
          `unknown kind heading "${heading}" in release ${current.version} — expected one of ${Object.keys(headings).join(', ')}`,
        )
      }
      if (current.changes.some((c) => c.kind === kind)) {
        fail(lineNo, `duplicate "${heading}" heading in release ${current.version}`)
      }
      const lastKind = current.changes.at(-1)
      const lastIndex = lastKind ? KIND_ORDER.indexOf(lastKind.kind) : -1
      if (KIND_ORDER.indexOf(kind) < lastIndex) {
        fail(
          lineNo,
          `"${heading}" is out of order in release ${current.version} — kinds must appear as New, Improved, Fixed`,
        )
      }
      current.changes.push({ kind, lines: [] })
      currentKind = kind
      continue
    }

    if (line.trim() === '') continue // blank line: fine anywhere inside a release

    if (currentKind === null) {
      fail(
        lineNo,
        `line outside any kind heading in release ${current.version}: ${JSON.stringify(line)}`,
      )
    }
    const bullet = BULLET.exec(line)
    if (!bullet || bullet[1] === undefined) {
      fail(
        lineNo,
        `expected a "- " bullet in a ${currentKind} section, got ${JSON.stringify(line)}`,
      )
    }
    const changeText = bullet[1].trim()
    if (changeText === '') {
      fail(lineNo, `empty bullet in release ${current.version}`)
    }
    // currentKind's own section is always the last one pushed onto `changes`.
    const section = current.changes.at(-1)
    if (!section) {
      fail(lineNo, `line outside any kind heading in release ${current.version}`)
    }
    section.lines.push(changeText)
  }

  finishRelease(lines.length)
  return releases
}

export interface MergedChange {
  kind: ChangeKind
  en: string
  ru: string
}

export interface MergedRelease {
  version: string
  date: string
  changes: MergedChange[]
}

/**
 * Pairs the two parsed files by position (release N of one against release N
 * of the other — both files are meant to list the same releases in the same
 * order) into the shape changelog.schema.ts validates. Strict: any
 * disagreement between the two languages throws, naming the version and kind
 * it was found at, rather than silently pairing the wrong lines together.
 */
export function mergeChangelogMarkdown(
  en: ParsedRelease[],
  ru: ParsedRelease[],
  enLabel: string,
  ruLabel: string,
): MergedRelease[] {
  function fail(message: string): never {
    throw new Error(message)
  }

  if (en.length !== ru.length) {
    fail(`${enLabel} has ${en.length} release(s) but ${ruLabel} has ${ru.length}`)
  }

  return en.map((enRelease, i) => {
    const ruRelease = ru[i]
    if (!ruRelease) fail(`${ruLabel} is missing release #${i + 1}`)
    if (enRelease.version !== ruRelease.version) {
      fail(
        `${enLabel} and ${ruLabel} disagree on release #${i + 1}'s version (${enRelease.version} vs ${ruRelease.version})`,
      )
    }
    const { version } = enRelease
    if (enRelease.date !== ruRelease.date) {
      fail(
        `${enLabel} and ${ruLabel} disagree on the date for ${version} (${enRelease.date} vs ${ruRelease.date})`,
      )
    }
    const enKinds = enRelease.changes.map((c) => c.kind)
    const ruKinds = ruRelease.changes.map((c) => c.kind)
    if (enKinds.join(',') !== ruKinds.join(',')) {
      fail(
        `${enLabel} and ${ruLabel} disagree on which kinds ${version} has (${enKinds.join(', ') || 'none'} vs ${ruKinds.join(', ') || 'none'})`,
      )
    }

    const changes: MergedChange[] = []
    for (const [k, enKind] of enRelease.changes.entries()) {
      const ruKind = ruRelease.changes[k]
      if (!ruKind) fail(`${ruLabel} is missing the "${enKind.kind}" section for ${version}`)
      if (enKind.lines.length !== ruKind.lines.length) {
        fail(
          `${enLabel} has ${enKind.lines.length} "${enKind.kind}" change(s) for ${version} but ${ruLabel} has ${ruKind.lines.length}`,
        )
      }
      for (const [j, enLine] of enKind.lines.entries()) {
        const ruLine = ruKind.lines[j]
        if (ruLine === undefined)
          fail(`${ruLabel} is missing a "${enKind.kind}" line for ${version}`)
        changes.push({ kind: enKind.kind, en: enLine, ru: ruLine })
      }
    }

    return { version, date: enRelease.date, changes }
  })
}
