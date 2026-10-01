// Edit history for library items, independent of which suggestion (if any)
// produced a given version — see db/schema.ts's own comment on
// library_item_versions for why a 'snapshot' row can exist with no suggestion
// behind it at all.

import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { libraryItemVersions, type libraryVersionSourceEnum } from '@/db/schema'

export type LibraryKind = 'agent' | 'skill'
type VersionSource = (typeof libraryVersionSourceEnum.enumValues)[number]
type LibraryItemVersionRow = typeof libraryItemVersions.$inferSelect

export interface LibraryItemVersionDto {
  version: number
  source: VersionSource
  suggestionId: string | null
  createdAt: string
  markdown: string
}

function toVersionDto(row: LibraryItemVersionRow): LibraryItemVersionDto {
  return {
    version: row.version,
    source: row.source,
    suggestionId: row.suggestionId,
    createdAt: row.createdAt.toISOString(),
    markdown: row.markdown,
  }
}

/**
 * Records a write to a library item, following the rule db/schema.ts
 * documents on library_item_versions: before the newly-written content is
 * recorded, if the content that was live on disk *before this write* differs
 * from the latest already-recorded version (or nothing has been recorded at
 * all), that pre-write content is inserted first, as a 'snapshot' version.
 * That captures both the ordinary pre-change baseline and any manual edit
 * made outside this flow since the last recorded version — either way, the
 * history never has a gap between "what was last recorded" and "what this
 * write actually replaced".
 *
 * `preWriteMarkdown` is `null` exactly for a brand new item (apply-create):
 * there is nothing on disk yet to snapshot, and version 1 is the newly
 * written content.
 *
 * Both inserts run in one transaction so a reader never observes the snapshot
 * half of this write without the suggestion half, or vice versa — and so the
 * unique (kind, name, version) index is what decides version numbers under a
 * concurrent writer, not a race between this function's own read and insert.
 *
 * Returns the version number of the newly-written content — what a caller
 * records as a suggestion's `appliedVersion`.
 */
export async function recordVersion(args: {
  kind: LibraryKind
  name: string
  preWriteMarkdown: string | null
  writtenMarkdown: string
  source: VersionSource
  suggestionId: string | null
}): Promise<number> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(libraryItemVersions)
      .where(and(eq(libraryItemVersions.kind, args.kind), eq(libraryItemVersions.name, args.name)))
      .orderBy(desc(libraryItemVersions.version))
      .limit(1)
    let next = (latest?.version ?? 0) + 1

    if (args.preWriteMarkdown !== null && args.preWriteMarkdown !== latest?.markdown) {
      await tx.insert(libraryItemVersions).values({
        kind: args.kind,
        name: args.name,
        version: next,
        markdown: args.preWriteMarkdown,
        source: 'snapshot',
        suggestionId: null,
      })
      next += 1
    }

    const [inserted] = await tx
      .insert(libraryItemVersions)
      .values({
        kind: args.kind,
        name: args.name,
        version: next,
        markdown: args.writtenMarkdown,
        source: args.source,
        suggestionId: args.suggestionId,
      })
      .returning({ version: libraryItemVersions.version })

    if (!inserted) throw new Error(`Failed to record a version for ${args.kind} ${args.name}`)
    return inserted.version
  })
}

/** Every recorded version of one item, newest first. */
export async function listVersions(
  kind: LibraryKind,
  name: string,
): Promise<LibraryItemVersionDto[]> {
  const rows = await db
    .select()
    .from(libraryItemVersions)
    .where(and(eq(libraryItemVersions.kind, kind), eq(libraryItemVersions.name, name)))
    .orderBy(desc(libraryItemVersions.version))
  return rows.map(toVersionDto)
}
