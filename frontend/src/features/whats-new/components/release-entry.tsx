import { useTranslation } from 'react-i18next'
import type { Tone } from '@/shared/components'
import { StatusBadge } from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { formatReleaseDate } from '../lib/format'
import type { ChangeKind, Release } from '../model/changelog.schema'

// new → success: a brand-new capability is good news, the same tone
// StatusDot reserves for "all clear" elsewhere. improved → accent: a change
// to something that already existed, not as attention-worthy as new or
// fixed. fixed → warning: it names a problem that existed, even though the
// news is that it's gone.
const KIND_TONE: Record<ChangeKind, Tone> = {
  new: 'success',
  improved: 'accent',
  fixed: 'warning',
}

// Always rendered in this order, in every row, regardless of which one kind
// a given change actually is — see the comment on the badge slot below.
const KINDS: readonly ChangeKind[] = ['new', 'improved', 'fixed']

/** One changelog release: its version/date, then each change as a compact
 *  badge-plus-one-liner row — entries are meant to read in a glance, not as
 *  prose, so there is no heading hierarchy here beyond the version itself. */
export function ReleaseEntry({ release, language }: { release: Release; language: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">v{release.version}</span>
        <span className="text-xs text-muted-foreground">
          {formatReleaseDate(release.date, language)}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {release.changes.map((change, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: changes never reorder, add, or remove within an already-rendered release — changelog data is static per load.
          <li key={index} className="flex items-start gap-2 text-sm">
            {/* The tag "slot": every kind's label is a different width (New /
                Improved / Fixed; Новое / Улучшено / Исправлено), so a plain
                single badge here would start each row's text at a different
                x position. All three badges are rendered in every row,
                stacked in the same 1×1 grid cell (`grid` + `col-start-1
                row-start-1` on each) with only the actual kind visible —
                the cell's own intrinsic width is then the widest of the
                three, identical on every row because every row renders the
                same three labels, so the text column lines up across the
                whole list without a single hard-coded width. A subgrid
                spanning every row would also size to the widest, but only
                among whichever kinds happen to appear somewhere in the
                list — this way doesn't depend on that. `justify-items-start`
                keeps each badge at its own natural width (left-aligned)
                rather than stretched to fill the cell; `invisible` (not
                `hidden`) is what keeps the other two in the width
                calculation while hiding them, and `aria-hidden` keeps a
                screen reader from announcing the kind three times. */}
            <span className="mt-0.5 grid shrink-0 justify-items-start">
              {KINDS.map((kind) => (
                <StatusBadge
                  key={kind}
                  tone={KIND_TONE[kind]}
                  className={cn('col-start-1 row-start-1', kind !== change.kind && 'invisible')}
                  aria-hidden={kind !== change.kind}
                >
                  {t(`whatsNew.kind.${kind}`)}
                </StatusBadge>
              ))}
            </span>
            <span>{language === 'ru' ? change.ru : change.en}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
