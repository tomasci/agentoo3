// Everything an agent is told about a session's attachments is rendered here,
// and only here — three surfaces (a system-prompt pointer, a per-turn
// announcement, and ATTACHMENTS.md itself), all pure string templating with
// no filesystem or database access, so every one of them is testable as exact
// output. See features/attachments/service.ts for the one caller that owns
// actually writing the manifest file and computing what has changed.

export interface ManifestFile {
  id: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  checksum: string
  lineCount: number | null
  pageCount: number | null
  createdAt: Date
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/** "4212 lines" or "14 pages" — whichever this file's mime type produced. */
function extentOf(file: {
  lineCount: number | null
  pageCount: number | null
}): string | undefined {
  if (file.lineCount !== null) return `${file.lineCount} line${file.lineCount === 1 ? '' : 's'}`
  if (file.pageCount !== null) return `${file.pageCount} page${file.pageCount === 1 ? '' : 's'}`
  return undefined
}

/**
 * Deterministic order for every rendering below: by upload time, then by id
 * to break a tie — so a no-op regeneration (nothing changed) produces
 * byte-identical output, which is what lets a test assert an exact string
 * instead of "contains".
 */
function ordered<T extends { id: string; createdAt: Date }>(files: T[]): T[] {
  return [...files].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )
}

/**
 * ATTACHMENTS.md: the full index, regenerated on every upload and delete.
 * Deliberately not CLAUDE.md — that is project context, shared and read from
 * the working directory, not a per-session, harness-generated file.
 */
export function renderManifest(files: ManifestFile[]): string {
  const header = [
    '# Attachments',
    '',
    'Files a human added to this session. Every subagent can read them too. This ' +
      'file is generated and read-only — do not Edit or Write it.',
    '',
  ]
  const body =
    files.length === 0
      ? ['No files yet.', '']
      : [
          '| File | Type | Size | Extent | SHA-256 | Added |',
          '| --- | --- | --- | --- | --- | --- |',
          ...ordered(files).map((f) => {
            const extent = extentOf(f) ?? '—'
            return `| ${f.originalFilename} | ${f.mimeType} | ${humanSize(f.sizeBytes)} | ${extent} | ${f.checksum.slice(0, 12)} | ${f.createdAt.toISOString()} |`
          }),
          '',
        ]
  return [...header, ...body].join('\n')
}

/**
 * The per-turn announcement prepended to a prompt for files this session has
 * that the agent has not yet been told about. Empty string for none, so a
 * caller can unconditionally prepend `announcement + prompt` — see
 * session-run.worker.ts, where this is composed once per turn from whatever
 * has `announcedSeq IS NULL`.
 */
export function announcementFor(uploadsDir: string, files: ManifestFile[]): string {
  if (files.length === 0) return ''

  const n = files.length
  const lines = ordered(files).map((f) => {
    const extent = extentOf(f)
    const parts = [f.mimeType, extent, humanSize(f.sizeBytes)].filter((p): p is string =>
      Boolean(p),
    )
    return `- ${f.originalFilename} — ${parts.join(', ')}`
  })

  return [
    `[attachments added] ${n} file${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} now available in ` +
      "this session's attachments directory",
    `(${uploadsDir}):`,
    ...lines,
    'The full index is ATTACHMENTS.md in that directory. It is read-only.',
    'Large files: use Grep, or Read with offset/limit — Read truncates past ~2000 lines or ~25k tokens.',
    '',
  ].join('\n')
}

/**
 * The system-prompt pointer (see SYSTEM_PROMPT_DYNAMIC_BOUNDARY in
 * runner-options.ts): a *pointer*, not the manifest. ATTACHMENTS.md changes on
 * every upload; re-sending its contents every turn would burn tokens on
 * something the agent can already read off disk.
 */
export function attachmentsSystemPromptBlock(
  uploadsDir: string,
  fileCount: number,
  manifestPath: string,
): string {
  return [
    'This session has files a human uploaded, available on disk (read-only) at:',
    uploadsDir,
    '',
    `${fileCount} file${fileCount === 1 ? '' : 's'} currently. The full index, with type, size and a ` +
      `checksum for each, is at ${manifestPath}.`,
  ].join('\n')
}
