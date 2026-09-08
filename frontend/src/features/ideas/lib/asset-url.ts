/**
 * The one route the OpenAPI router does not carry: it serves raw bytes
 * (Content-Disposition, a real image Content-Type for a thumbnail), which the
 * generated axios client neither preserves nor exposes — same reason
 * `sessions/lib/attachments.ts`'s `sessionFileUrl` is a hand-built path rather
 * than a generated call. Addressed by the asset's own id alone (`/idea-assets/
 * {id}/download`, features/ideas/routes.ts) — no idea id in the path, unlike
 * a session file.
 */
export function ideaAssetDownloadUrl(assetId: string): string {
  return `/api/idea-assets/${assetId}/download`
}

/** The four types the backend serves inline with a real image Content-Type
 * (features/ideas/routes.ts's own `INLINE_IMAGE_TYPES`) — everything else
 * comes back `application/octet-stream` and is never worth an `<img>`
 * attempt. Not load-bearing if this ever drifts from the backend's own list:
 * a mismatch only costs a thumbnail that 404s onto a file-chip fallback,
 * mirroring `sessions/lib/attachments.ts`'s identical constant and its own
 * comment on the same trade-off. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mimeType)
}
