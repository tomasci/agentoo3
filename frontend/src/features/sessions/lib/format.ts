const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `createdAt` parsed, or `null` for anything that isn't a real instant. */
function parse(createdAt: string): Date | null {
  if (!createdAt) return null
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * A message's `createdAt` as a quiet `HH:MM`, never as the literal "Invalid
 * Date" — fixtures and compacted history both send `''`, and that string has
 * no business reaching the transcript.
 */
export function formatTime(createdAt: string): string | null {
  const date = parse(createdAt)
  return date ? TIME.format(date) : null
}

/** The full date and time, for the `title` attribute behind a short `formatTime`. */
export function formatFullTime(createdAt: string): string | null {
  const date = parse(createdAt)
  return date?.toLocaleString() ?? null
}
