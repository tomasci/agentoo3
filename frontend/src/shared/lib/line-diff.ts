export type DiffLineType = 'context' | 'remove' | 'add'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/**
 * A line-based diff of two markdown documents, via the classic LCS table.
 *
 * Inputs here are a library item's whole markdown body — tens to a few
 * hundred lines, not a monorepo — so the O(n*m) DP table this walks is
 * simpler to write and to test than Myers' O(ND), and fast enough for what
 * it is actually asked to diff. Built for the suggestion review page's
 * before/after view (`suggestion-diff.tsx`): a pure function so the diff
 * itself is unit-testable without mounting anything.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length > 0 ? before.split('\n') : []
  const b = after.length > 0 ? after.split('\n') : []
  const n = a.length
  const m = b.length

  // lcs[i][j] holds the LCS length of a[i:] and b[j:], filled bottom-up so
  // the walk below can read one step ahead without recursion. Read through
  // `lcsAt` throughout rather than a non-null assertion: every index this
  // walks is in bounds by construction, but Biome's `noNonNullAssertion`
  // does not know that, and a bounds-checked helper reads the same either way.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  const lcsAt = (row: number, col: number): number => lcs[row]?.[col] ?? 0

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i]
      if (!row) continue
      row[j] = a[i] === b[j] ? lcsAt(i + 1, j + 1) + 1 : Math.max(lcsAt(i + 1, j), lcsAt(i, j + 1))
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const lineA = a[i] ?? ''
    const lineB = b[j] ?? ''
    if (lineA === lineB) {
      result.push({ type: 'context', text: lineA })
      i++
      j++
    } else if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
      result.push({ type: 'remove', text: lineA })
      i++
    } else {
      result.push({ type: 'add', text: lineB })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i] ?? '' })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] ?? '' })
    j++
  }
  return result
}
