// Mirrors features/sessions/lib/format.ts's own pair — each feature keeps a
// tiny copy rather than sharing one, the same duplication ideas/storage/docker
// already carry their own of.

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function parse(value: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** An ISO timestamp as the reader's own locale date and time, or '' for
 *  anything that isn't a real instant (null, '', unparsable). */
export function formatDateTime(value: string | null): string {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : ''
}
