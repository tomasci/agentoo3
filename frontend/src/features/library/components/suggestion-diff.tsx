import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type DiffLine, diffLines } from '@/shared/lib/line-diff'
import { cn } from '@/shared/lib/utils'

/** Lines of unchanged context kept visible at each edge of a long run before
 *  it folds — enough to show what a change sits next to without the whole
 *  unmodified document sitting on screen. */
const CONTEXT_RADIUS = 3
/** A context run shorter than this just renders in full — collapsing it
 *  would hide fewer lines than the toggle itself takes up. */
const COLLAPSE_THRESHOLD = CONTEXT_RADIUS * 2 + 4

/** A `DiffLine` plus its position in the whole diff — assigned once, before
 *  grouping/slicing, so every line keeps one stable key no matter which
 *  group or slice (head/tail of a folded run) it ends up rendered in. */
interface NumberedLine extends DiffLine {
  key: number
}

interface DiffGroup {
  type: 'context' | 'changed'
  lines: NumberedLine[]
}

/** Runs of consecutive same-kind lines — a `context` run can fold, a
 *  `changed` one (add/remove, possibly interleaved as a replacement) never
 *  does. */
function groupRuns(diff: NumberedLine[]): DiffGroup[] {
  const groups: DiffGroup[] = []
  for (const line of diff) {
    const type = line.type === 'context' ? 'context' : 'changed'
    const last = groups.at(-1)
    if (last?.type === type) last.lines.push(line)
    else groups.push({ type, lines: [line] })
  }
  return groups
}

function DiffRow({ line }: { line: DiffLine }) {
  const gutter = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''
  return (
    <div
      className={cn(
        'flex gap-2 px-3 py-0.5 whitespace-pre-wrap',
        line.type === 'add' && 'bg-primary/10',
        line.type === 'remove' && 'bg-destructive/10',
      )}
    >
      <span aria-hidden="true" className="w-3 shrink-0 select-none text-muted-foreground">
        {gutter}
      </span>
      <span className="min-w-0 flex-1 wrap-anywhere">{line.text}</span>
    </div>
  )
}

function DiffRows({ lines }: { lines: NumberedLine[] }) {
  return (
    <>
      {lines.map((line) => (
        <DiffRow key={line.key} line={line} />
      ))}
    </>
  )
}

/**
 * The review page's before/after view for a `modify` suggestion: a unified
 * (not side-by-side) line diff, computed by the pure `diffLines` so the
 * logic is unit-tested on its own (tests/line-diff.test.ts) rather than only
 * through this render. Removed lines carry a `-` gutter and
 * `bg-destructive/10`, added lines a `+` gutter and `bg-primary/10` — the
 * same opacity-modified semantic tokens the README names as the allowed way
 * to carry a tone no flat token does — and unchanged lines carry neither.
 * A long unchanged run folds behind a count, keeping `CONTEXT_RADIUS` lines
 * visible on each side of the fold so a change never loses the context right
 * next to it.
 */
export function SuggestionDiff({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation()
  const groups = useMemo(() => {
    const numbered = diffLines(before, after).map((line, key) => ({ ...line, key }))
    return groupRuns(numbered)
  }, [before, after])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  return (
    <div className="overflow-hidden rounded-lg border font-mono text-sm">
      {groups.map((group, groupIndex) => {
        const groupKey = group.lines[0]?.key ?? groupIndex

        if (group.type === 'changed' || group.lines.length <= COLLAPSE_THRESHOLD) {
          return (
            <div key={groupKey}>
              <DiffRows lines={group.lines} />
            </div>
          )
        }

        if (expanded.has(groupKey)) {
          return (
            <div key={groupKey}>
              <DiffRows lines={group.lines} />
            </div>
          )
        }

        const head = group.lines.slice(0, CONTEXT_RADIUS)
        const tail = group.lines.slice(group.lines.length - CONTEXT_RADIUS)
        const hidden = group.lines.length - head.length - tail.length
        return (
          <div key={groupKey}>
            <DiffRows lines={head} />
            <button
              type="button"
              onClick={() => setExpanded((prev) => new Set(prev).add(groupKey))}
              className="block w-full border-y bg-muted px-3 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t('library.suggestions.detail.showUnchanged', { count: hidden })}
            </button>
            <DiffRows lines={tail} />
          </div>
        )
      })}
    </div>
  )
}
