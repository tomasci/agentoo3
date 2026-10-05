// The topbar bell: merges two already-existing sources — unchecked session
// results (features/sessions/service.ts's uncheckedSql, via
// listUncheckedSessionHeads) and pending learning suggestions
// (features/learning/suggestions.ts's listPendingSuggestionHeads) — into one
// feed, and tracks exactly one new piece of state: how far the operator has
// read. See backend/README.md's "Notifications" section for why.
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { systemSettings } from '@/db/schema'
import type { PendingSuggestionHead } from '@/features/learning/suggestions'
import { listPendingSuggestionHeads } from '@/features/learning/suggestions'
import type { UncheckedSessionHead } from '@/features/sessions/service'
import { listUncheckedSessionHeads } from '@/features/sessions/service'
import { logger } from '@/lib/logger'
import {
  type MarkNotificationsReadInput,
  NOTIFICATIONS_LIMIT,
  NOTIFICATIONS_READ_THROUGH_KEY,
  type NotificationFeedDto,
  type NotificationItemDto,
  type StoredReadThrough,
  storedReadThroughSchema,
} from './schema'

/**
 * Serialises every write to the watermark — see markNotificationsRead for why
 * a read-then-max-then-upsert needs one — with a transaction-scoped
 * `pg_advisory_xact_lock`, not db/client.ts's `withAdvisoryLock`
 * (session-level `pg_advisory_lock`, held on a connection reserved just for
 * the lock). That shape needs *two* pool connections per caller while the
 * lock is held: the reserved one, plus whatever `fn` borrows from the same
 * pool to actually read and write. With only 10 connections in the pool, 11
 * concurrent POSTs can each grab the reserved connection for the lock before
 * any of them frees a second connection to run `fn` on, and every one of
 * them — plus every unrelated query in the process — ends up waiting
 * forever. A transaction-scoped lock has no second connection to wait for:
 * it lives and dies with the one connection its own transaction already
 * holds, so a caller that is waiting on the lock is not also holding a
 * connection hostage, and a burst of POSTs can never exhaust the pool.
 */
const READ_THROUGH_LOCK_KEY = 'notifications:read-through'

type SessionEntry = {
  source: 'session'
  id: string
  at: string
  projectId: string
  projectName: string
  title: string | null
  status: UncheckedSessionHead['status']
}

type SuggestionEntry = {
  source: 'suggestion'
  id: string
  at: string
  kind: PendingSuggestionHead['kind']
  action: PendingSuggestionHead['action']
  name: string
  title: string
}

/** One merged-feed row, before `unread` is known — that depends on the
 * watermark, which getNotificationFeed and markNotificationsRead each read
 * (or write) at a different point, so it is applied after this shape exists
 * rather than baked into it. */
type FeedEntry = SessionEntry | SuggestionEntry

/**
 * Newest first; ties broken session-before-suggestion, then id ascending —
 * exact tie-breaks matter because `at` only has millisecond resolution, and
 * two items landing in the same millisecond must still sort the same way on
 * every call for item identity across GET/POST to be stable.
 */
function compareEntries(a: FeedEntry, b: FeedEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  if (a.source !== b.source) return a.source === 'session' ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The feed's membership and order, with no notion of read/unread yet — the
 * one place that calls both existing list functions and merges them, so
 * getNotificationFeed and markNotificationsRead (which has to recompute the
 * feed fresh at write time, see its own comment) can never disagree about
 * what is in it.
 *
 * Both sources are asked for NOTIFICATIONS_LIMIT + 1: that is enough to know
 * whether the merged, capped result is `truncated` without a separate
 * COUNT(*) against either table.
 */
async function collectFeed(): Promise<{ entries: FeedEntry[]; truncated: boolean }> {
  const take = NOTIFICATIONS_LIMIT + 1
  const [sessionHeads, suggestionHeads] = await Promise.all([
    listUncheckedSessionHeads(take),
    listPendingSuggestionHeads(take),
  ])

  const sessionEntries: SessionEntry[] = sessionHeads.map((s) => ({
    source: 'session',
    id: s.id,
    // Never null for a row uncheckedSql selected — see that column's own
    // comment on UncheckedSessionHead.
    at: s.settledAt.toISOString(),
    projectId: s.projectId,
    projectName: s.projectName,
    title: s.title,
    status: s.status,
  }))
  const suggestionEntries: SuggestionEntry[] = suggestionHeads.map((s) => ({
    source: 'suggestion',
    id: s.id,
    at: s.createdAt.toISOString(),
    kind: s.kind,
    action: s.action,
    name: s.name,
    title: s.title,
  }))

  const merged = [...sessionEntries, ...suggestionEntries].sort(compareEntries)
  return {
    entries: merged.slice(0, NOTIFICATIONS_LIMIT),
    truncated: merged.length > NOTIFICATIONS_LIMIT,
  }
}

function toItem(entry: FeedEntry, readThroughMs: number): NotificationItemDto {
  // The only unread comparison in this feature, and deliberately entirely in
  // TypeScript: `at` came from a JS Date's own toISOString() above, so it
  // already carries no more than millisecond precision, matching
  // readThroughMs below exactly. library_suggestions.created_at is Postgres
  // `defaultNow()` (microsecond precision) — a SQL `created_at > readThrough`
  // comparison would compare that microsecond value against a watermark that
  // can only ever name a millisecond, so the newest suggestion in any given
  // millisecond would read unread forever, no matter how recently it was
  // marked read. Comparing two already-millisecond-truncated values here
  // instead is what makes "mark read" actually stick.
  const unread = new Date(entry.at).getTime() > readThroughMs
  return { ...entry, unread }
}

function toFeedDto(
  feed: { entries: FeedEntry[]; truncated: boolean },
  readThroughMs: number,
): NotificationFeedDto {
  const items = feed.entries.map((entry) => toItem(entry, readThroughMs))
  // Exact for the whole feed, not just this page: every entry past the cap
  // sorts strictly older than feed.entries[0] (see compareEntries), and
  // unread-ness is monotonic in `at`, so if nothing in `items` is unread
  // nothing truncated away could be either.
  return { items, hasUnread: items.some((item) => item.unread), truncated: feed.truncated }
}

/**
 * Reads the one system_settings row this feature owns, treating both "no
 * row" and "a row that fails to validate" as absent — mirrors
 * whats-new/service.ts's own readSetting (see that file's header for why a
 * hand-edited or stale value degrades the feature instead of 500ing the
 * request that asked).
 *
 * Takes its executor rather than hardcoding `db`: markNotificationsRead reads
 * this row from inside the transaction that holds READ_THROUGH_LOCK_KEY, so
 * its read has to run on that same transaction's connection, not borrow a
 * second one from the pool — see that lock's own comment for why.
 */
async function readStoredReadThrough(
  executor: Pick<typeof db, 'select'>,
): Promise<StoredReadThrough | undefined> {
  const [row] = await executor
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, NOTIFICATIONS_READ_THROUGH_KEY))
    .limit(1)
  if (!row) return undefined

  const parsed = storedReadThroughSchema.safeParse(row.value)
  if (!parsed.success) {
    logger.warn(
      `Stored ${NOTIFICATIONS_READ_THROUGH_KEY} (${JSON.stringify(row.value)}) does not match ` +
        'the expected shape — treating it as unset',
    )
    return undefined
  }
  return parsed.data
}

/** -Infinity reads as "nothing read yet" — every item's `at` is strictly
 * greater than it, so a missing or malformed row makes every item unread. */
async function readThroughMs(executor: Pick<typeof db, 'select'> = db): Promise<number> {
  const stored = await readStoredReadThrough(executor)
  return stored ? new Date(stored.readThrough).getTime() : Number.NEGATIVE_INFINITY
}

export async function getNotificationFeed(): Promise<NotificationFeedDto> {
  const [feed, ms] = await Promise.all([collectFeed(), readThroughMs()])
  return toFeedDto(feed, ms)
}

/**
 * Marks the feed read up to `input.upTo`, clamped so it can never move past
 * the newest item that actually exists right now, and never backwards.
 *
 * The feed is recomputed fresh here rather than trusting whatever the client
 * last saw with GET — that is what makes "an item that arrives between the
 * client's GET and its POST stays unread" true: this function's own idea of
 * `newest` always reflects anything that landed in between, so a stale or
 * even future-dated `upTo` can only ever clamp down to what was real at the
 * moment this ran, never forward past it.
 *
 * Nothing is written when the feed is empty — there is no "newest" to clamp
 * to, and marking read something that lists no items would be a watermark
 * with nothing behind it.
 */
export async function markNotificationsRead(
  input: MarkNotificationsReadInput,
): Promise<NotificationFeedDto> {
  const feed = await collectFeed()
  const newest = feed.entries[0]?.at
  if (newest === undefined) return toFeedDto(feed, Number.NEGATIVE_INFINITY)

  const newMs = await db.transaction(async (tx) => {
    // pg_advisory_xact_lock, not pg_advisory_lock: held by the transaction,
    // released automatically at commit or rollback, on the same connection
    // the read and upsert below already run on — see READ_THROUGH_LOCK_KEY's
    // own comment for why that matters.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${READ_THROUGH_LOCK_KEY}, 0))`,
    )
    const currentMs = await readThroughMs(tx)
    const candidateMs = Math.min(new Date(input.upTo).getTime(), new Date(newest).getTime())
    const nextMs = Math.max(currentMs, candidateMs)
    const value = { readThrough: new Date(nextMs).toISOString() }
    await tx
      .insert(systemSettings)
      .values({ key: NOTIFICATIONS_READ_THROUGH_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      })
    return nextMs
  })

  return toFeedDto(feed, newMs)
}
