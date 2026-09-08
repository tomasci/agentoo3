// The Idea Manager's database layer: the board itself, its canvas (blocks and
// groups), feedback comments, generated prompts, and the read-only view onto
// runs a later track owns. features/ideas/files.ts covers assets; this module
// only wraps its two idea-scoped functions down to the single-id shape the
// flattened /idea-assets/{id} routes need — see deleteIdeaAsset/
// downloadIdeaAsset below.
//
// What this module deliberately does NOT do, because a later track owns it:
// watch for a card landing on 'selected_for_development', create the session a
// handoff runs in, send a prompt into that session, or close an idea_runs row
// when a turn ends. createIdeaPrompt (below) is the seam that track calls into
// for its own "generate a prompt" step, exactly the same function this
// feature's own POST /ideas/{id}/prompts route calls.

import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  ideaBlocks,
  ideaComments,
  ideaFiles,
  ideaGroups,
  ideaPrompts,
  ideaRuns,
  ideas,
  projects,
  sessions,
} from '@/db/schema'
import { deleteIdeaFiles } from '@/features/attachments/storage'
import { deleteIdeaFile, getIdeaFileForDownload } from '@/features/ideas/files'
import type { IdeaBlockInput, IdeaInput } from '@/features/ideas/serialize'
import { serializeIdea, serializeIdeaFollowUp } from '@/features/ideas/serialize'
import { badRequest, conflict, notFound } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { enqueueIdeaPrompt } from '@/queue'
import type {
  CreateIdeaBlockInput,
  CreateIdeaCommentInput,
  CreateIdeaGroupInput,
  CreateIdeaInput,
  CreateIdeaPromptInput,
  IdeaBlockDto,
  IdeaCommentDto,
  IdeaDto,
  IdeaGroupDto,
  IdeaPromptDto,
  IdeaRunDto,
  MoveIdeaInput,
  ReorderIdeaBlocksInput,
  UpdateIdeaBlockInput,
  UpdateIdeaGroupInput,
  UpdateIdeaInput,
} from './schema'

type IdeaRow = typeof ideas.$inferSelect
type IdeaBlockRow = typeof ideaBlocks.$inferSelect
type IdeaGroupRow = typeof ideaGroups.$inferSelect
type IdeaCommentRow = typeof ideaComments.$inferSelect
type IdeaPromptRow = typeof ideaPrompts.$inferSelect
type IdeaRunRow = typeof ideaRuns.$inferSelect

async function requireIdeaRow(id: string): Promise<IdeaRow> {
  const [row] = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1)
  if (!row) throw notFound('Idea')
  return row
}

async function requireProject(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!row) throw notFound('Project')
  return row
}

// --- ideas: the board --------------------------------------------------------

/** Batched counts/joins for a page of idea rows, so listing a board (or
 * fetching one card) never fans out one query per idea — mirrors
 * features/sessions/service.ts's countsFor/pendingFor. */
async function blockCountsFor(ideaIds: string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map()
  const rows = await db
    .select({ ideaId: ideaBlocks.ideaId, n: count() })
    .from(ideaBlocks)
    .where(inArray(ideaBlocks.ideaId, ideaIds))
    .groupBy(ideaBlocks.ideaId)
  return new Map(rows.map((r) => [r.ideaId, Number(r.n)]))
}

async function commentCountsFor(ideaIds: string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map()
  const rows = await db
    .select({ ideaId: ideaComments.ideaId, n: count() })
    .from(ideaComments)
    .where(inArray(ideaComments.ideaId, ideaIds))
    .groupBy(ideaComments.ideaId)
  return new Map(rows.map((r) => [r.ideaId, Number(r.n)]))
}

async function assetCountsFor(ideaIds: string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map()
  const rows = await db
    .select({ ideaId: ideaFiles.ideaId, n: count() })
    .from(ideaFiles)
    .where(and(inArray(ideaFiles.ideaId, ideaIds), isNull(ideaFiles.deletedAt)))
    .groupBy(ideaFiles.ideaId)
  return new Map(rows.map((r) => [r.ideaId, Number(r.n)]))
}

type LatestPrompt = {
  id: string
  kind: IdeaPromptRow['kind']
  status: IdeaPromptRow['status']
  assumptions: IdeaPromptRow['assumptions']
}

/** The most recently created prompt per idea, one query rather than N — rows
 * come back newest-first, so the first one seen per ideaId is the latest.
 * Carries `assumptions` too (not just id/kind/status) so the board can show
 * them on the card straight from this batched query — see ideaSchema's own
 * comment on latestPrompt for why that field exists at all. */
async function latestPromptFor(ideaIds: string[]): Promise<Map<string, LatestPrompt>> {
  if (ideaIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: ideaPrompts.id,
      ideaId: ideaPrompts.ideaId,
      kind: ideaPrompts.kind,
      status: ideaPrompts.status,
      assumptions: ideaPrompts.assumptions,
    })
    .from(ideaPrompts)
    .where(inArray(ideaPrompts.ideaId, ideaIds))
    .orderBy(desc(ideaPrompts.createdAt))
  const out = new Map<string, LatestPrompt>()
  for (const row of rows) {
    if (!out.has(row.ideaId)) {
      out.set(row.ideaId, {
        id: row.id,
        kind: row.kind,
        status: row.status,
        assumptions: row.assumptions,
      })
    }
  }
  return out
}

type OpenRun = { id: string; status: IdeaRunRow['status'] }

/** The one idea_runs row with no endedAt yet, per idea — idea_runs_open_key
 * (db/schema.ts) guarantees there is at most one. */
async function openRunFor(ideaIds: string[]): Promise<Map<string, OpenRun>> {
  if (ideaIds.length === 0) return new Map()
  const rows = await db
    .select({ id: ideaRuns.id, ideaId: ideaRuns.ideaId, status: ideaRuns.status })
    .from(ideaRuns)
    .where(and(inArray(ideaRuns.ideaId, ideaIds), isNull(ideaRuns.endedAt)))
  return new Map(rows.map((r) => [r.ideaId, { id: r.id, status: r.status }]))
}

async function sessionStatusFor(sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await db
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
  return new Map(rows.map((r) => [r.id, r.status]))
}

async function toDtoBatch(rows: IdeaRow[]): Promise<IdeaDto[]> {
  const ideaIds = rows.map((r) => r.id)
  const sessionIds = [
    ...new Set(rows.map((r) => r.sessionId).filter((id): id is string => id !== null)),
  ]
  const [blocks, comments, assets, latestPrompt, openRun, sessionStatus] = await Promise.all([
    blockCountsFor(ideaIds),
    commentCountsFor(ideaIds),
    assetCountsFor(ideaIds),
    latestPromptFor(ideaIds),
    openRunFor(ideaIds),
    sessionStatusFor(sessionIds),
  ])
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    status: r.status,
    boardPosition: r.boardPosition,
    sessionId: r.sessionId,
    orchestrator: r.orchestrator,
    baseBranch: r.baseBranch,
    maxBudgetUsd: r.maxBudgetUsd,
    lastError: r.lastError,
    blockCount: blocks.get(r.id) ?? 0,
    commentCount: comments.get(r.id) ?? 0,
    assetCount: assets.get(r.id) ?? 0,
    latestPrompt: latestPrompt.get(r.id) ?? null,
    sessionStatus: r.sessionId ? (sessionStatus.get(r.sessionId) ?? null) : null,
    openRun: openRun.get(r.id) ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

/** The board's only read shape: every idea for a project, grouped by column
 * and ordered within it — mirrors ideas_project_status_idx exactly. */
export async function listIdeas(projectId: string): Promise<IdeaDto[]> {
  await requireProject(projectId)
  const rows = await db
    .select()
    .from(ideas)
    .where(eq(ideas.projectId, projectId))
    .orderBy(ideas.status, ideas.boardPosition)
  return toDtoBatch(rows)
}

export async function getIdea(id: string): Promise<IdeaDto> {
  const row = await requireIdeaRow(id)
  const [dto] = await toDtoBatch([row])
  if (!dto) throw new Error(`toDtoBatch produced nothing for idea ${id}`)
  return dto
}

/** Spacing new positions are given, both on append and on renumber — see
 * moveIdea's own comment for why a renumber lands on exact multiples of it. */
const BOARD_POSITION_STEP = 1000

async function appendPosition(projectId: string, status: IdeaRow['status']): Promise<number> {
  const [last] = await db
    .select({ boardPosition: ideas.boardPosition })
    .from(ideas)
    .where(and(eq(ideas.projectId, projectId), eq(ideas.status, status)))
    .orderBy(desc(ideas.boardPosition))
    .limit(1)
  return (last?.boardPosition ?? 0) + BOARD_POSITION_STEP
}

export async function createIdea(projectId: string, input: CreateIdeaInput): Promise<IdeaDto> {
  await requireProject(projectId)
  const status = input.status ?? 'backlog'
  const boardPosition = await appendPosition(projectId, status)
  const [row] = await db
    .insert(ideas)
    .values({
      projectId,
      title: input.title,
      status,
      boardPosition,
      orchestrator: input.orchestrator ?? null,
      baseBranch: input.baseBranch ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')
  return getIdea(row.id)
}

export async function updateIdea(id: string, input: UpdateIdeaInput): Promise<IdeaDto> {
  await requireIdeaRow(id)
  await db
    .update(ideas)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.orchestrator !== undefined && { orchestrator: input.orchestrator }),
      ...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
      ...(input.maxBudgetUsd !== undefined && { maxBudgetUsd: input.maxBudgetUsd }),
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, id))
  return getIdea(id)
}

/**
 * Delete a card and everything on its canvas.
 *
 * Blocked while a handoff is in flight (idea_runs_open_key's row still open):
 * deleting out from under it would cascade-delete the very run record that
 * would otherwise explain what happened to it, mirroring deleteSession's own
 * refusal while a turn is running (features/sessions/service.ts). Once past
 * that guard, the DB row cascades everything else (blocks, groups, comments,
 * prompts, runs); only the bytes on disk need a separate, best-effort cleanup
 * — same reasoning as deleteSession's own deleteSessionFiles call.
 */
export async function deleteIdea(id: string): Promise<void> {
  await requireIdeaRow(id)
  const [openRun] = await db
    .select({ id: ideaRuns.id })
    .from(ideaRuns)
    .where(and(eq(ideaRuns.ideaId, id), isNull(ideaRuns.endedAt)))
    .limit(1)
  if (openRun) {
    throw conflict('This idea has a handoff in progress; wait for it to finish before deleting')
  }

  try {
    await deleteIdeaFiles(id)
  } catch (error) {
    logger.warn(`Could not remove attachments for idea ${id}: ${String(error)}`)
  }

  await db.delete(ideas).where(eq(ideas.id, id))
}

/** Below this gap, a midpoint is no longer trusted — see moveIdea's own
 * comment for why. */
const BOARD_POSITION_EPSILON = 1e-6

/**
 * Move a card to a status and a slot within it.
 *
 * The midpoint of its two new neighbours is the ordinary case. Repeatedly
 * dropping new cards into the same narrowing gap (always between a fixed
 * card and whatever was dropped there last) halves that gap every time, and a
 * double has nowhere near enough precision to keep that up forever — after
 * roughly fifty rounds the "midpoint" stops being distinguishable from one of
 * its own neighbours, and a card silently stops being able to move there at
 * all, with nothing to point at afterward. So the gap is checked against an
 * epsilon (generously early, not at the exact point double-precision would
 * finally fail) and, when it is too small, the whole destination column is
 * renumbered to evenly spaced integers instead — in this same transaction,
 * with the moved card inserted at the slot it asked for.
 */
export async function moveIdea(id: string, input: MoveIdeaInput): Promise<IdeaDto> {
  const { status } = input
  const afterId = input.afterId ?? null
  const beforeId = input.beforeId ?? null
  if (afterId !== null && afterId === beforeId) {
    throw badRequest('afterId and beforeId must not be the same card')
  }

  await db.transaction(async (tx) => {
    const [idea] = await tx.select().from(ideas).where(eq(ideas.id, id)).limit(1)
    if (!idea) throw notFound('Idea')

    const siblings = await tx
      .select({ id: ideas.id, boardPosition: ideas.boardPosition })
      .from(ideas)
      .where(and(eq(ideas.projectId, idea.projectId), eq(ideas.status, status), ne(ideas.id, id)))
      .orderBy(ideas.boardPosition, ideas.id)
    const positionOf = new Map(siblings.map((s) => [s.id, s.boardPosition]))

    if (afterId !== null && !positionOf.has(afterId)) {
      throw badRequest('afterId is not a card in the destination column')
    }
    if (beforeId !== null && !positionOf.has(beforeId)) {
      throw badRequest('beforeId is not a card in the destination column')
    }

    const afterPos = afterId !== null ? (positionOf.get(afterId) ?? null) : null
    const beforePos = beforeId !== null ? (positionOf.get(beforeId) ?? null) : null
    if (afterPos !== null && beforePos !== null && afterPos >= beforePos) {
      throw badRequest('afterId must sit immediately before beforeId in the destination column')
    }

    let candidate: number
    let exhausted = false
    if (afterPos === null && beforePos === null) {
      // Neither neighbour given: append to the end of the column (or take
      // the only slot, if it is empty). This is the status-only move with no
      // drag position behind it (e.g. a button rather than a drag) — and
      // appending never reorders a card the caller said nothing about, the
      // way guessing "top" would.
      const last = siblings.at(-1)
      candidate = last ? last.boardPosition + BOARD_POSITION_STEP : BOARD_POSITION_STEP
    } else if (afterPos === null) {
      candidate = (beforePos as number) - BOARD_POSITION_STEP
    } else if (beforePos === null) {
      candidate = afterPos + BOARD_POSITION_STEP
    } else {
      candidate = (afterPos + beforePos) / 2
      exhausted =
        beforePos - afterPos < BOARD_POSITION_EPSILON ||
        candidate === afterPos ||
        candidate === beforePos
    }

    if (!exhausted) {
      await tx
        .update(ideas)
        .set({ status, boardPosition: candidate, updatedAt: new Date() })
        .where(eq(ideas.id, id))
      return
    }

    const ordered = siblings.map((s) => ({ id: s.id }))
    const insertAt = afterId !== null ? ordered.findIndex((s) => s.id === afterId) + 1 : 0
    ordered.splice(insertAt, 0, { id })
    for (const [index, sibling] of ordered.entries()) {
      await tx
        .update(ideas)
        .set({
          boardPosition: (index + 1) * BOARD_POSITION_STEP,
          ...(sibling.id === id && { status, updatedAt: new Date() }),
        })
        .where(eq(ideas.id, sibling.id))
    }
  })

  return getIdea(id)
}

// --- canvas: blocks -----------------------------------------------------------
//
// See schema.ts's own comment on the block schemas for the body/meta mapping
// every function below relies on.

type BlockContent =
  | { kind: 'note' | 'requirement' | 'example'; text: string }
  | { kind: 'link'; url: string; label: string | null }
  | { kind: 'image'; assetId: string; caption: string | null }

function blockContent(row: IdeaBlockRow): BlockContent {
  switch (row.kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return { kind: row.kind, text: row.body }
    case 'link':
      return {
        kind: 'link',
        url: row.body,
        label: (row.meta as { label?: string | null } | null)?.label ?? null,
      }
    case 'image':
      return {
        kind: 'image',
        assetId: row.body,
        caption: (row.meta as { caption?: string | null } | null)?.caption ?? null,
      }
  }
}

function toBlockDto(row: IdeaBlockRow): IdeaBlockDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    groupId: row.groupId,
    seq: row.seq,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    ...blockContent(row),
  } as IdeaBlockDto
}

/** The shape features/ideas/serialize.ts consumes — deliberately excludes
 * x/y/w/h, see that module's own comment on why. */
function toBlockInput(row: IdeaBlockRow): IdeaBlockInput {
  return { id: row.id, seq: row.seq, groupId: row.groupId, ...blockContent(row) } as IdeaBlockInput
}

async function requireOwnGroup(ideaId: string, groupId: string): Promise<IdeaGroupRow> {
  const [row] = await db
    .select()
    .from(ideaGroups)
    .where(and(eq(ideaGroups.id, groupId), eq(ideaGroups.ideaId, ideaId)))
    .limit(1)
  if (!row) throw badRequest('groupId does not belong to this idea')
  return row
}

async function requireOwnReadyAsset(ideaId: string, assetId: string): Promise<void> {
  const [row] = await db
    .select({ id: ideaFiles.id })
    .from(ideaFiles)
    .where(
      and(
        eq(ideaFiles.id, assetId),
        eq(ideaFiles.ideaId, ideaId),
        isNull(ideaFiles.deletedAt),
        eq(ideaFiles.status, 'ready'),
      ),
    )
    .limit(1)
  if (!row) throw badRequest('assetId does not refer to a ready asset on this idea')
}

/** Atomically hands out the next reading-order slot for one idea's blocks,
 * from ideas.nextSeq — the same pattern sendMessage uses for messages.seq
 * (features/sessions/service.ts): a returning `UPDATE ... SET next_seq =
 * next_seq + 1` so two concurrent creations can never collide on
 * idea_blocks_idea_seq_key. */
async function allocateBlockSeq(ideaId: string): Promise<number> {
  const [row] = await db
    .update(ideas)
    .set({ nextSeq: sql`${ideas.nextSeq} + 1`, updatedAt: new Date() })
    .where(eq(ideas.id, ideaId))
    .returning({ seq: ideas.nextSeq })
  if (!row) throw notFound('Idea')
  return row.seq - 1
}

function columnsForCreate(input: CreateIdeaBlockInput): {
  kind: IdeaBlockRow['kind']
  body: string
  meta: Record<string, unknown> | null
} {
  switch (input.kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return { kind: input.kind, body: input.text, meta: null }
    case 'link':
      return { kind: 'link', body: input.url, meta: { label: input.label ?? null } }
    case 'image':
      return { kind: 'image', body: input.assetId, meta: { caption: input.caption ?? null } }
  }
}

export async function listIdeaBlocks(ideaId: string): Promise<IdeaBlockDto[]> {
  await requireIdeaRow(ideaId)
  const rows = await db
    .select()
    .from(ideaBlocks)
    .where(eq(ideaBlocks.ideaId, ideaId))
    .orderBy(ideaBlocks.seq)
  return rows.map(toBlockDto)
}

export async function createIdeaBlock(
  ideaId: string,
  input: CreateIdeaBlockInput,
): Promise<IdeaBlockDto> {
  await requireIdeaRow(ideaId)
  if (input.groupId) await requireOwnGroup(ideaId, input.groupId)
  if (input.kind === 'image') await requireOwnReadyAsset(ideaId, input.assetId)

  const seq = await allocateBlockSeq(ideaId)
  const { kind, body, meta } = columnsForCreate(input)
  const [row] = await db
    .insert(ideaBlocks)
    .values({
      ideaId,
      groupId: input.groupId ?? null,
      seq,
      kind,
      body,
      meta,
      x: input.x ?? 0,
      y: input.y ?? 0,
      w: input.w ?? null,
      h: input.h ?? null,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')
  return toBlockDto(row)
}

/** Which of `input`'s content fields apply to `row`'s own (immutable) kind —
 * see schema.ts's updateIdeaBlockSchema comment for why this is not a
 * discriminated union. Fields for the wrong kind are silently ignored, same
 * as an unrelated PATCH field would be. */
function columnsForUpdate(
  row: IdeaBlockRow,
  input: UpdateIdeaBlockInput,
): { body?: string; meta?: Record<string, unknown> | null } {
  switch (row.kind) {
    case 'note':
    case 'requirement':
    case 'example':
      return input.text !== undefined ? { body: input.text } : {}
    case 'link': {
      const patch: { body?: string; meta?: Record<string, unknown> } = {}
      if (input.url !== undefined) patch.body = input.url
      if (input.label !== undefined) patch.meta = { label: input.label }
      return patch
    }
    case 'image': {
      const patch: { body?: string; meta?: Record<string, unknown> } = {}
      if (input.assetId !== undefined) patch.body = input.assetId
      if (input.caption !== undefined) patch.meta = { caption: input.caption }
      return patch
    }
  }
}

export async function updateIdeaBlock(
  blockId: string,
  input: UpdateIdeaBlockInput,
): Promise<IdeaBlockDto> {
  const [existing] = await db.select().from(ideaBlocks).where(eq(ideaBlocks.id, blockId)).limit(1)
  if (!existing) throw notFound('Block')

  if (input.groupId !== undefined && input.groupId !== null) {
    await requireOwnGroup(existing.ideaId, input.groupId)
  }
  const contentPatch = columnsForUpdate(existing, input)
  if (existing.kind === 'image' && contentPatch.body !== undefined) {
    await requireOwnReadyAsset(existing.ideaId, contentPatch.body)
  }

  const [row] = await db
    .update(ideaBlocks)
    .set({
      ...contentPatch,
      ...(input.groupId !== undefined && { groupId: input.groupId }),
      ...(input.x !== undefined && { x: input.x }),
      ...(input.y !== undefined && { y: input.y }),
      ...(input.w !== undefined && { w: input.w }),
      ...(input.h !== undefined && { h: input.h }),
    })
    .where(eq(ideaBlocks.id, blockId))
    .returning()
  if (!row) throw new Error('Update returned no row')
  return toBlockDto(row)
}

export async function deleteIdeaBlock(blockId: string): Promise<void> {
  const [row] = await db.select().from(ideaBlocks).where(eq(ideaBlocks.id, blockId)).limit(1)
  if (!row) throw notFound('Block')
  await db.delete(ideaBlocks).where(eq(ideaBlocks.id, blockId))
}

/**
 * Reassign every one of this idea's blocks to a new reading order in one
 * shot — the correcting half of `idea_blocks.seq` (see db/schema.ts's own
 * comment on that column: dragging a card only ever moves x/y, never seq, so
 * this is the sole way a user — or, on the spatial canvas, a "reorder from
 * layout" command — can fix a reading order they can see is wrong).
 *
 * Two-phase write (offset, then settle), not a single pass in some clever
 * per-row order: `input.order` is an arbitrary permutation of this idea's
 * current seq values, and an arbitrary permutation can contain cycles (the
 * simplest being a two-block swap) for which *no* ordering of individual
 * per-row UPDATEs avoids, at some point, writing a value another
 * not-yet-updated row still holds. `idea_blocks_idea_seq_key` is a plain,
 * non-deferrable unique index — checked at the end of each statement, not at
 * commit — so that is not a survivable "transient" duplicate; it is a
 * unique-violation that aborts the whole transaction. Phase one moves every
 * row to a negative sentinel derived from its own current seq (still unique,
 * since the seq it came from was, and disjoint from every real seq, which is
 * always >= 0) to clear the value space entirely; phase two then writes each
 * row's real target value into what is now empty ground, so no write in
 * either phase can ever collide with a value another row still holds.
 *
 * The value *set* handed back out is exactly the one already in use — each
 * row keeps one of the idea's existing seq values, just reassigned to a
 * (possibly different) row — rather than a fresh 0..n-1 renumbering, so
 * `ideas.nextSeq` (which only has to stay above every value ever handed out)
 * never needs touching here.
 *
 * `ideas.updatedAt` is deliberately left alone: see handoff.ts's
 * claimSelectedIdeas and run-close.ts's own comment on that column for why a
 * write that is not a remedy for a stuck/failed handoff must not move that
 * retry watermark forward — a reorder is exactly such a write.
 */
export async function reorderIdeaBlocks(
  ideaId: string,
  input: ReorderIdeaBlocksInput,
): Promise<IdeaBlockDto[]> {
  await requireIdeaRow(ideaId)

  const orderIds = new Set(input.order)
  if (orderIds.size !== input.order.length) {
    throw badRequest('order contains a duplicate block id')
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ideaBlocks)
      .where(eq(ideaBlocks.ideaId, ideaId))
      .orderBy(ideaBlocks.seq)

    if (input.order.length !== rows.length) {
      throw badRequest(
        `order must name exactly this idea's ${rows.length} block(s) (got ${input.order.length})`,
      )
    }
    const rowsById = new Map(rows.map((r) => [r.id, r]))
    for (const id of input.order) {
      if (!rowsById.has(id)) throw badRequest(`Block ${id} does not belong to this idea`)
    }
    // order.length === rows.length, no duplicates, and every id in order is a
    // key of rowsById (also size rows.length): an injective map between two
    // sets of the same size is a bijection, so this is now known to be an
    // exact permutation — nothing missing, nothing extra.

    const currentOrder = rows.map((r) => r.id) // already ascending by seq
    if (currentOrder.every((id, index) => id === input.order[index])) {
      return rows.map(toBlockDto) // idempotent: the requested order already holds
    }

    // Phase 1 — offset: vacate every seq value this idea currently occupies.
    for (const row of rows) {
      await tx
        .update(ideaBlocks)
        .set({ seq: -(row.seq + 1) })
        .where(eq(ideaBlocks.id, row.id))
    }

    // Phase 2 — settle: hand the same set of real values back out, in the
    // requested order.
    const seqValues = rows.map((r) => r.seq).sort((a, b) => a - b)
    for (const [index, id] of input.order.entries()) {
      await tx.update(ideaBlocks).set({ seq: seqValues[index] }).where(eq(ideaBlocks.id, id))
    }

    const updated = await tx
      .select()
      .from(ideaBlocks)
      .where(eq(ideaBlocks.ideaId, ideaId))
      .orderBy(ideaBlocks.seq)
    return updated.map(toBlockDto)
  })
}

// --- canvas: groups -------------------------------------------------------------

function toGroupDto(row: IdeaGroupRow): IdeaGroupDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    seq: row.seq,
    title: row.title,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
  }
}

/**
 * Unlike idea_blocks, idea_groups carries no unique index on (ideaId, seq) —
 * see db/schema.ts, where `ideas.nextSeq` is documented as being for blocks
 * specifically. A group's seq is a heading order, not something the reading
 * order of the generated prompt depends on being collision-free (serialize.ts
 * tie-breaks by id if two ever match), so a plain MAX(seq)+1 is enough here;
 * unlike allocateBlockSeq, two concurrent creations could in principle both
 * compute the same value, and that is an accepted, harmless race rather than
 * one this needs the sessions.nextSeq-style atomic counter to prevent.
 */
async function nextGroupSeq(ideaId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${ideaGroups.seq})` })
    .from(ideaGroups)
    .where(eq(ideaGroups.ideaId, ideaId))
  return (row?.max ?? -1) + 1
}

export async function listIdeaGroups(ideaId: string): Promise<IdeaGroupDto[]> {
  await requireIdeaRow(ideaId)
  const rows = await db
    .select()
    .from(ideaGroups)
    .where(eq(ideaGroups.ideaId, ideaId))
    .orderBy(ideaGroups.seq)
  return rows.map(toGroupDto)
}

export async function createIdeaGroup(
  ideaId: string,
  input: CreateIdeaGroupInput,
): Promise<IdeaGroupDto> {
  await requireIdeaRow(ideaId)
  const seq = await nextGroupSeq(ideaId)
  const [row] = await db
    .insert(ideaGroups)
    .values({
      ideaId,
      seq,
      title: input.title,
      x: input.x ?? 0,
      y: input.y ?? 0,
      w: input.w ?? null,
      h: input.h ?? null,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')
  return toGroupDto(row)
}

export async function updateIdeaGroup(
  groupId: string,
  input: UpdateIdeaGroupInput,
): Promise<IdeaGroupDto> {
  const [existing] = await db.select().from(ideaGroups).where(eq(ideaGroups.id, groupId)).limit(1)
  if (!existing) throw notFound('Group')

  const [row] = await db
    .update(ideaGroups)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.x !== undefined && { x: input.x }),
      ...(input.y !== undefined && { y: input.y }),
      ...(input.w !== undefined && { w: input.w }),
      ...(input.h !== undefined && { h: input.h }),
    })
    .where(eq(ideaGroups.id, groupId))
    .returning()
  if (!row) throw new Error('Update returned no row')
  return toGroupDto(row)
}

/** ON DELETE SET NULL (idea_blocks.group_id) already un-groups every block
 * that pointed here — nothing else to clean up. */
export async function deleteIdeaGroup(groupId: string): Promise<void> {
  const [row] = await db.select().from(ideaGroups).where(eq(ideaGroups.id, groupId)).limit(1)
  if (!row) throw notFound('Group')
  await db.delete(ideaGroups).where(eq(ideaGroups.id, groupId))
}

// --- feedback: comments ----------------------------------------------------------

function toCommentDto(row: IdeaCommentRow): IdeaCommentDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
  }
}

export async function listIdeaComments(ideaId: string): Promise<IdeaCommentDto[]> {
  await requireIdeaRow(ideaId)
  const rows = await db
    .select()
    .from(ideaComments)
    .where(eq(ideaComments.ideaId, ideaId))
    .orderBy(ideaComments.createdAt, ideaComments.id)
  return rows.map(toCommentDto)
}

export async function createIdeaComment(
  ideaId: string,
  input: CreateIdeaCommentInput,
): Promise<IdeaCommentDto> {
  await requireIdeaRow(ideaId)
  const [row] = await db.insert(ideaComments).values({ ideaId, body: input.body }).returning()
  if (!row) throw new Error('Insert returned no row')
  return toCommentDto(row)
}

export async function deleteIdeaComment(commentId: string): Promise<void> {
  const [row] = await db.select().from(ideaComments).where(eq(ideaComments.id, commentId)).limit(1)
  if (!row) throw notFound('Comment')
  await db.delete(ideaComments).where(eq(ideaComments.id, commentId))
}

// --- prompts ----------------------------------------------------------------------

function toPromptDto(row: IdeaPromptRow): IdeaPromptDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    kind: row.kind,
    sourceDigest: row.sourceDigest,
    generatedTitle: row.generatedTitle,
    generatedText: row.generatedText,
    assumptions: row.assumptions,
    model: row.model,
    costUsd: row.costUsd,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  }
}

export async function listIdeaPrompts(ideaId: string): Promise<IdeaPromptDto[]> {
  await requireIdeaRow(ideaId)
  const rows = await db
    .select()
    .from(ideaPrompts)
    .where(eq(ideaPrompts.ideaId, ideaId))
    .orderBy(desc(ideaPrompts.createdAt))
  return rows.map(toPromptDto)
}

/** Everything features/ideas/serialize.ts needs for one idea, mapped from
 * whatever executor (the plain `db`, or an open `tx`) the caller already has
 * — createIdeaPrompt below needs the transactional view; nothing else here
 * currently does, but taking the executor as a parameter rather than hardcoding
 * `db` keeps that one caller from being a special case. */
async function loadIdeaInput(
  executor: Pick<typeof db, 'select'>,
  ideaId: string,
  title: string,
): Promise<IdeaInput> {
  const [blockRows, groupRows, assetRows] = await Promise.all([
    executor.select().from(ideaBlocks).where(eq(ideaBlocks.ideaId, ideaId)),
    executor.select().from(ideaGroups).where(eq(ideaGroups.ideaId, ideaId)),
    executor
      .select()
      .from(ideaFiles)
      .where(
        and(
          eq(ideaFiles.ideaId, ideaId),
          isNull(ideaFiles.deletedAt),
          eq(ideaFiles.status, 'ready'),
        ),
      ),
  ])
  return {
    title,
    blocks: blockRows.map(toBlockInput),
    groups: groupRows.map((g) => ({ id: g.id, seq: g.seq, title: g.title })),
    assets: assetRows.map((f) => ({
      id: f.id,
      filename: f.originalFilename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    })),
  }
}

/** Read when a followup's own digest has nothing better to report — an idea
 * whose bound session has not yet been closed by the (later) handoff track
 * cannot have one at all, which is exactly what the precondition below this
 * guards against generating a followup over. */
const NO_RUN_SUMMARY = '(No summary was recorded for the previous run.)'

async function getIdeaPromptOrThrow(id: string): Promise<IdeaPromptDto> {
  const [row] = await db.select().from(ideaPrompts).where(eq(ideaPrompts.id, id)).limit(1)
  if (!row) throw new Error(`Idea prompt ${id} disappeared immediately after being inserted`)
  return toPromptDto(row)
}

/**
 * Generate (or regenerate) a development prompt for this idea.
 *
 * Building the source document, inserting the `pending` row, and — for a
 * followup — stamping `consumedAt` on every currently-unconsumed comment all
 * happen in one transaction, and the generation job is enqueued only once
 * that transaction has committed. That ordering closes a real race: the
 * worker (features/ideas/prompt-service.ts) reads only the stored
 * `sourceDigest`, never the live canvas, so a comment that arrives between
 * "the digest was computed" and "the job actually runs" can never end up
 * folded into the prompt without being marked consumed, or marked consumed
 * without ever having reached one — both are unreachable specifically
 * because the digest and the consumedAt stamps are written together, before
 * anything is queued to read either.
 *
 * A retry — reposting the same `kind` while the most recent prompt of that
 * kind is still `pending` (the known gap: the generation queue is
 * `attempts: 1`, so a worker killed mid-generation leaves a row stuck
 * forever) or has ended `failed` — does not rebuild the digest at all; it
 * copies the stale/failed row's `sourceDigest` verbatim into a fresh pending
 * row. Rebuilding it instead would, for a followup, either drop comments
 * that attempt was meant to fold in (already stamped consumedAt by its own
 * transaction) or re-consume ones a genuinely new followup should see
 * instead. The new row simply supersedes the old one as the one thing the
 * worker will ever act on for that attempt — nothing here blocks a repost on
 * the mere existence of a stale row.
 *
 * A retry also re-points any still-open idea_runs row that was pointing at
 * the row it just superseded (the UPDATE right after the INSERT below).
 * Without that, a card stuck on a pending prompt that never generated (this
 * function's own reason to exist) stays stuck even after a successful
 * regenerate: features/ideas/handoff.ts's progressOpenRuns reads the prompt
 * through the run's own `promptId`, which claimIdeaForHandoff set once, at
 * claim time, and never revisits on its own. Scoped to `endedAt IS NULL`
 * (an open run) and to the exact `promptId` this retry supersedes, so an
 * ordinary first-time generation (no run pointing at anything yet) and a
 * `failed`-retry with no run left open (already closed needs_attention by
 * the sweep) both leave this as a no-op, matched or not.
 */
export async function createIdeaPrompt(
  ideaId: string,
  input: CreateIdeaPromptInput,
): Promise<IdeaPromptDto> {
  const idea = await requireIdeaRow(ideaId)
  const project = await requireProject(idea.projectId)

  // Guard the handoff preconditions here, before a paid model call runs over
  // a canvas that could never be handed off anyway. sendMessage
  // (features/sessions/service.ts) checks the same two things, but 400s deep
  // inside a session-shaped error — useless on an idea card, which is why
  // both are re-stated here naming the idea instead.
  if (!idea.orchestrator) {
    throw badRequest('This idea has no orchestrator. Choose one before generating a prompt.')
  }
  if (project.status !== 'ready') {
    throw conflict(`Project is "${project.status}"; it has to finish setup first`)
  }

  let insertedId = ''

  await db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(ideaPrompts)
      .where(eq(ideaPrompts.ideaId, ideaId))
      .orderBy(desc(ideaPrompts.createdAt))
      .limit(1)

    const isRetry =
      latest !== undefined &&
      latest.kind === input.kind &&
      (latest.status === 'pending' || latest.status === 'failed')

    let sourceDigest: string
    if (isRetry) {
      sourceDigest = latest.sourceDigest
    } else if (input.kind === 'initial') {
      sourceDigest = serializeIdea(await loadIdeaInput(tx, ideaId, idea.title))
    } else {
      // followup: needs a run this idea already went through, and the prompt
      // that run was given, to build "what the session did" and "the prompt
      // already sent" around.
      const [closedRun] = await tx
        .select()
        .from(ideaRuns)
        .where(and(eq(ideaRuns.ideaId, ideaId), isNotNull(ideaRuns.endedAt)))
        .orderBy(desc(ideaRuns.endedAt))
        .limit(1)
      if (!closedRun) {
        throw conflict('This idea has no completed run yet to follow up on')
      }
      const [previousReady] = await tx
        .select()
        .from(ideaPrompts)
        .where(and(eq(ideaPrompts.ideaId, ideaId), eq(ideaPrompts.status, 'ready')))
        .orderBy(desc(ideaPrompts.createdAt))
        .limit(1)
      if (!previousReady?.generatedText) {
        throw conflict('This idea has no successfully generated prompt yet to follow up on')
      }

      const unconsumed = await tx
        .select()
        .from(ideaComments)
        .where(and(eq(ideaComments.ideaId, ideaId), isNull(ideaComments.consumedAt)))

      // The run-closing track (not this one) is what populates outcome/detail
      // with whatever it knows about the turn — this only formats what is
      // already there, honestly, rather than inventing a transcript summary
      // this module has no business synthesizing.
      const sessionDigest =
        [closedRun.outcome ? `Outcome: ${closedRun.outcome}` : null, closedRun.detail]
          .filter((v): v is string => Boolean(v))
          .join('\n\n') || NO_RUN_SUMMARY

      sourceDigest = serializeIdeaFollowUp(
        await loadIdeaInput(tx, ideaId, idea.title),
        previousReady.generatedText,
        sessionDigest,
        unconsumed.map((c) => ({ id: c.id, text: c.body, createdAt: c.createdAt.toISOString() })),
      )

      if (unconsumed.length > 0) {
        await tx
          .update(ideaComments)
          .set({ consumedAt: new Date() })
          .where(
            inArray(
              ideaComments.id,
              unconsumed.map((c) => c.id),
            ),
          )
      }
    }

    const [row] = await tx
      .insert(ideaPrompts)
      .values({ ideaId, kind: input.kind, sourceDigest, status: 'pending' })
      .returning({ id: ideaPrompts.id })
    if (!row) throw new Error('Insert returned no row')
    insertedId = row.id

    if (isRetry && latest) {
      // See this function's own comment above: re-point, never leave
      // pointing at the row this insert just superseded.
      await tx
        .update(ideaRuns)
        .set({ promptId: insertedId })
        .where(
          and(
            eq(ideaRuns.ideaId, ideaId),
            eq(ideaRuns.promptId, latest.id),
            isNull(ideaRuns.endedAt),
          ),
        )
    }
  })

  // Only after the transaction above has committed — see this function's own
  // comment for why that order is the whole point of it.
  await enqueueIdeaPrompt({ promptId: insertedId })

  return getIdeaPromptOrThrow(insertedId)
}

// --- runs: read-only here; created and closed by the handoff track --------------

function toRunDto(row: IdeaRunRow): IdeaRunDto {
  return {
    id: row.id,
    ideaId: row.ideaId,
    sessionId: row.sessionId,
    promptId: row.promptId,
    promptMessageId: row.promptMessageId,
    kind: row.kind,
    status: row.status,
    outcome: row.outcome,
    detail: row.detail,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  }
}

export async function listIdeaRuns(ideaId: string): Promise<IdeaRunDto[]> {
  await requireIdeaRow(ideaId)
  const rows = await db
    .select()
    .from(ideaRuns)
    .where(eq(ideaRuns.ideaId, ideaId))
    .orderBy(desc(ideaRuns.startedAt))
  return rows.map(toRunDto)
}

// --- assets: flattening /idea-assets/{id} down to files.ts's (ideaId, fileId) ---
//
// features/ideas/files.ts's uploadIdeaFile/listIdeaFiles are used directly
// from routes.ts (both already take the idea id the nested /ideas/{id}/assets
// path provides); only delete and download are addressed by the asset's own
// id alone (see this feature's endpoint list), so only those two need the
// idea id resolved here first.

async function requireIdeaFileRow(fileId: string) {
  const [row] = await db
    .select()
    .from(ideaFiles)
    .where(and(eq(ideaFiles.id, fileId), isNull(ideaFiles.deletedAt)))
    .limit(1)
  if (!row) throw notFound('File')
  return row
}

export async function deleteIdeaAsset(fileId: string): Promise<void> {
  const row = await requireIdeaFileRow(fileId)
  await deleteIdeaFile(row.ideaId, fileId)
}

export async function downloadIdeaAsset(
  fileId: string,
  range?: { start: number; end: number },
): ReturnType<typeof getIdeaFileForDownload> {
  const row = await requireIdeaFileRow(fileId)
  return getIdeaFileForDownload(row.ideaId, fileId, range)
}
