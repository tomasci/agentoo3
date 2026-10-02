/** Bytes as the shortest readable figure for a stored env file: `0 B`,
 * `412 B`, `2.1 KB`. Own copy rather than a cross-feature import (same
 * reasoning as storage/lib/format.ts's `formatDateTime` below) — kept to
 * B/KB only, deliberately narrower than system/lib/format.ts's `formatBytes`,
 * since a single file here is capped at 64 KiB
 * (ENV_FILE_MAX_CONTENT_BYTES, backend/src/features/env-files/schema.ts) and
 * never reaches MB. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
}

/** The full local date and time, or `null` for anything that isn't a real
 * instant — mirrors storage/lib/format.ts's `formatDateTime`, kept as its
 * own copy rather than a cross-feature import for one line of Intl. */
export function formatUpdatedAt(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}
