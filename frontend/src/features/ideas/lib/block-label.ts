import type { IdeaBlock } from '../hooks/use-idea-canvas'

/**
 * How long a name is allowed to get before this truncates it itself, rather
 * than leaving that entirely to the explorer row's own CSS ellipsis — a
 * caller (a test, say) can reference this instead of hardcoding "60".
 */
export const BLOCK_LABEL_MAX_LENGTH = 60

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string): string {
  return value.length > BLOCK_LABEL_MAX_LENGTH
    ? `${value.slice(0, BLOCK_LABEL_MAX_LENGTH)}…`
    : value
}

/** The first line of `text` that is not itself blank once collapsed — a
 * block's own body can open with blank lines, which a naive `split('\n')[0]`
 * would turn into an empty name even though the block has real content a
 * line or two down. */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const collapsed = collapseWhitespace(line)
    if (collapsed) return collapsed
  }
  return ''
}

/**
 * The single-line name the structure explorer (`components/idea-canvas.tsx`)
 * shows for a block — the closest thing a block has to a filename. Kept free
 * of i18n and React on purpose (a plain function of the block plus whatever
 * string the caller has already resolved) so it is unit-testable without
 * either: an empty result for a text block means "nothing written yet", and
 * the caller falls back to the translated kind label
 * (`ideas.canvas.kind.<kind>`) for that case rather than this module owning
 * any copy of its own.
 */
export function blockLabel(
  block: IdeaBlock,
  /** `assetsById.get(block.assetId)?.originalFilename` for an `image` block —
   * resolved by the caller rather than looked up in here, since that lookup
   * already exists at every call site and this stays a plain function of
   * already-known strings instead of a second copy of that map lookup. */
  assetFilename?: string,
): string {
  switch (block.kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return truncate(firstNonEmptyLine(block.text))
    case 'link':
      return truncate(collapseWhitespace(block.label || block.url))
    case 'image':
      // The asset behind an image block can outlive its own row (deleted
      // separately from the block that references it), which is exactly what
      // `caption`, then the raw id, exist to cover.
      return assetFilename || block.caption || block.assetId
  }
}
