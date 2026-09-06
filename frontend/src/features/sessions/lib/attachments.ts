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
