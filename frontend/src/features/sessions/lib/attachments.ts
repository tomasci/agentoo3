/**
 * The one route the OpenAPI router does not carry: it serves raw bytes
 * (Content-Disposition, a real image Content-Type for a thumbnail), which
 * the generated axios client neither preserves nor exposes — same reason
 * `/api/sessions/:id/export` is a hand-built anchor in session-page.tsx
 * rather than a generated call.
 */
export function sessionFileUrl(sessionId: string, fileId: string): string {
  return `/api/sessions/${sessionId}/files/${fileId}`
}

/** The four types the backend serves inline with a real image Content-Type
 * (attachments/routes.ts's INLINE_IMAGE_TYPES) — everything else, allowed or
 * not, comes back `application/octet-stream` and is never worth an `<img>`
 * attempt. Not load-bearing if this list ever drifts from the backend's own:
 * a mismatch only costs a thumbnail that 404s onto the file-chip fallback,
 * never a broken render (see `AttachmentThumbnail`'s `onError`). */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mimeType)
}

/**
 * An attachment tile's second line: `"<EXT> · <detail>"`, or just `<detail>`
 * when the filename carries no extension — shared by the composer's tray and
 * the transcript's own tiles so the two never drift on how this reads.
 * `detail` is whatever fits the tile's own state, not always a size: a
 * formatted byte count for a finished upload, an in-flight percentage for one
 * still uploading.
 */
export function attachmentDescription(filename: string, detail: string): string {
  const dot = filename.lastIndexOf('.')
  const hasExt = dot > 0 && dot < filename.length - 1
  return hasExt ? `${filename.slice(dot + 1).toUpperCase()} · ${detail}` : detail
}
