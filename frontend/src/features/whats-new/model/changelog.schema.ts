import { z } from 'zod'

// The shape of changelog.json, validated at the boundary — a hand-edited
// entry with a typo'd kind or a missing translation fails loudly at import
// time (see changelog.ts) rather than rendering a blank badge or an English
// fallback three layers into the dialog.

export const changeKindSchema = z.enum(['new', 'improved', 'fixed'])
export type ChangeKind = z.infer<typeof changeKindSchema>

export const changeSchema = z.object({
  kind: changeKindSchema,
  en: z.string().min(1),
  ru: z.string().min(1),
})
export type Change = z.infer<typeof changeSchema>

export const releaseSchema = z.object({
  // Dotted numeric version (`1.2.150`), not semver's full grammar — it has to
  // split cleanly into integers for sortReleasesByVersionDescending below.
  version: z.string().regex(/^\d+(\.\d+)*$/, 'Expected a dotted numeric version, e.g. "1.2.150"'),
  date: z.iso.date(),
  changes: z.array(changeSchema).min(1),
})
export type Release = z.infer<typeof releaseSchema>

export const changelogSchema = z.object({
  releases: z.array(releaseSchema),
})

/** Each part compared as a number, not as a string — "1.2.9" has to sort
 *  after "1.2.10", which `Array#sort`'s default lexicographic compare would
 *  get backwards. Exported on its own so a test can feed it a deliberately
 *  shuffled fixture rather than trusting changelog.json's own (already
 *  descending) order to prove anything. */
export function sortReleasesByVersionDescending<T extends { version: string }>(
  releases: readonly T[],
): T[] {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version))
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Parses, then sorts newest-first — the one place changelog.json's raw
 *  contents are trusted. */
export function parseChangelog(data: unknown): Release[] {
  return sortReleasesByVersionDescending(changelogSchema.parse(data).releases)
}
