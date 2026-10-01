// The human review surface over what the learning job proposed — see
// db/schema.ts's own header on library_suggestions for the invariants this
// enforces (no rename on apply, a model-authored body is re-validated before
// it ever reaches disk, a rejected suggestion stays around until explicitly
// deleted so the job never re-proposes it).
//
// Nothing here writes a library file directly: applying a suggestion runs
// through the exact same createAgent/updateAgent/createSkill/updateSkill path
// (features/library/service.ts) a human editing the Library UI would, so
// every invariant that already holds for a hand-edited item — path safety,
// name validation, project-plugin sync on a future read — holds here too.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { librarySuggestions, projects, sessions } from '@/db/schema'
import {
  type CreateAgentInput,
  type CreateSkillInput,
  createAgentSchema,
  createSkillSchema,
} from '@/features/library/schema'
import { createAgent, createSkill, updateAgent, updateSkill } from '@/features/library/service'
import { badRequest, conflict, issuesFor, notFound } from '@/lib/errors'
import { agentPath, agentToMarkdown, skillDir, skillToMarkdown } from '@/library'
import type { LibraryKind } from './versions'
import { recordVersion } from './versions'

export type LibrarySuggestionRow = typeof librarySuggestions.$inferSelect

export interface SourceSessionRef {
  id: string
  title: string | null
  projectId: string
  projectName: string
}

export interface LibrarySuggestionSummaryDto {
  id: string
  runId: string | null
  kind: LibraryKind
  action: 'create' | 'modify'
  name: string
  title: string
  rationale: string
  status: 'pending' | 'applied' | 'rejected'
  createdAt: string
  decidedAt: string | null
  appliedVersion: number | null
  sourceSessions: SourceSessionRef[]
  targetExists: boolean
  stale: boolean
}

export interface LibrarySuggestionDto extends LibrarySuggestionSummaryDto {
  proposed: Record<string, unknown>
  proposedMarkdown: string
  baseMarkdown: string | null
  currentMarkdown: string | null
  currentHash: string | null
}

function sha256Hex(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

/** Where this suggestion's target lives on disk, regardless of action — a
 * 'create' suggestion's target simply does not exist yet, ordinarily. */
function targetPath(kind: LibraryKind, name: string): string {
  return kind === 'agent' ? agentPath(name) : join(skillDir(name), 'SKILL.md')
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** What would be written if this suggestion were applied, rendered from the
 * stored `proposed` body — never read back from disk, since nothing has been
 * written yet at the point this is shown. */
function renderProposedMarkdown(
  kind: LibraryKind,
  name: string,
  proposed: Record<string, unknown>,
): string {
  if (kind === 'agent') {
    // `proposed` was validated against createAgentSchema.omit({ name: true })
    // at insert time (see insertSuggestion below) — this cast reflects that,
    // not a boundary this function itself is responsible for checking.
    return agentToMarkdown(proposed as Parameters<typeof agentToMarkdown>[0])
  }
  const skill = proposed as { description: string; body: string }
  return skillToMarkdown(name, skill.description, skill.body)
}

/** Every source session that still exists, in one batched query — a session
 * can be deleted out from under a suggestion that cites it (see
 * sourceSessionIds's own comment in db/schema.ts), and this is what lets a
 * caller omit exactly those without a query per suggestion. */
async function resolveSourceSessions(ids: string[]): Promise<Map<string, SourceSessionRef>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      projectId: sessions.projectId,
      projectName: projects.name,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(inArray(sessions.id, ids))
  return new Map(rows.map((row) => [row.id, row]))
}

function buildSummary(
  row: LibrarySuggestionRow,
  currentMarkdown: string | null,
  sessionMap: Map<string, SourceSessionRef>,
): LibrarySuggestionSummaryDto {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    action: row.action,
    name: row.name,
    title: row.title,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    appliedVersion: row.appliedVersion,
    sourceSessions: row.sourceSessionIds
      .map((id) => sessionMap.get(id))
      .filter((s): s is SourceSessionRef => s !== undefined),
    targetExists: currentMarkdown !== null,
    // Only meaningful for 'modify': a 'create' suggestion has no baseline to
    // have drifted from, and baseMarkdown is always null for it.
    stale: row.action === 'modify' && currentMarkdown !== row.baseMarkdown,
  }
}

async function toDetail(
  row: LibrarySuggestionRow,
  sessionMap: Map<string, SourceSessionRef>,
): Promise<LibrarySuggestionDto> {
  const currentMarkdown = await readIfExists(targetPath(row.kind, row.name))
  return {
    ...buildSummary(row, currentMarkdown, sessionMap),
    proposed: row.proposed,
    proposedMarkdown: renderProposedMarkdown(row.kind, row.name, row.proposed),
    baseMarkdown: row.baseMarkdown,
    currentMarkdown,
    currentHash: currentMarkdown === null ? null : sha256Hex(currentMarkdown),
  }
}

async function detailFromRow(row: LibrarySuggestionRow): Promise<LibrarySuggestionDto> {
  const sessionMap = await resolveSourceSessions(row.sourceSessionIds)
  return toDetail(row, sessionMap)
}

async function selectRow(id: string): Promise<LibrarySuggestionRow | undefined> {
  const [row] = await db
    .select()
    .from(librarySuggestions)
    .where(eq(librarySuggestions.id, id))
    .limit(1)
  return row
}

// --- reading -----------------------------------------------------------------

export async function listSuggestions(
  status: 'pending' | 'applied' | 'rejected' = 'pending',
): Promise<LibrarySuggestionSummaryDto[]> {
  const rows = await db
    .select()
    .from(librarySuggestions)
    .where(eq(librarySuggestions.status, status))
    .orderBy(desc(librarySuggestions.createdAt))

  const sessionMap = await resolveSourceSessions([
    ...new Set(rows.flatMap((row) => row.sourceSessionIds)),
  ])
  return Promise.all(
    rows.map(async (row) =>
      buildSummary(row, await readIfExists(targetPath(row.kind, row.name)), sessionMap),
    ),
  )
}

export async function getSuggestion(id: string): Promise<LibrarySuggestionDto> {
  const row = await selectRow(id)
  if (!row) throw notFound('Suggestion')
  return detailFromRow(row)
}

// --- writing (round 2's own entry point) -------------------------------------

export interface InsertSuggestionInput {
  runId: string | null
  kind: LibraryKind
  action: 'create' | 'modify'
  name: string
  title: string
  rationale: string
  sourceSessionIds: string[]
  // Exactly createAgentSchema/createSkillSchema minus `name` — validated here
  // against the full schema with `name` filled in from the field above, the
  // same shape apply-time re-validation uses, so a suggestion that insertion
  // accepted is guaranteed to re-validate cleanly later.
  proposed: Record<string, unknown>
  baseMarkdown: string | null
}

function validateProposed(
  kind: LibraryKind,
  name: string,
  proposed: Record<string, unknown>,
): CreateAgentInput | CreateSkillInput {
  const candidate = { name, ...proposed }
  const parsed =
    kind === 'agent'
      ? createAgentSchema.safeParse(candidate)
      : createSkillSchema.safeParse(candidate)
  if (!parsed.success) {
    const detail = issuesFor(parsed.error)
      .map((i) => `${i.path || '(root)'}: ${i.message}`)
      .join('; ')
    throw badRequest(`Proposed ${kind} body is invalid: ${detail}`)
  }
  return parsed.data
}

export async function insertSuggestion(
  input: InsertSuggestionInput,
): Promise<LibrarySuggestionRow> {
  // Validated at insert time too, not only at apply time: a malformed
  // proposal from the model should never make it into the review queue at
  // all, rather than surfacing as a 400 only once a human tries to apply it.
  const parsed = validateProposed(input.kind, input.name, input.proposed)
  const { name: _name, ...body } = parsed

  const [row] = await db
    .insert(librarySuggestions)
    .values({
      runId: input.runId,
      kind: input.kind,
      action: input.action,
      name: input.name,
      title: input.title,
      rationale: input.rationale,
      sourceSessionIds: input.sourceSessionIds,
      proposed: body,
      baseMarkdown: input.baseMarkdown,
    })
    .returning()
  if (!row) throw new Error('Insert returned no row')
  return row
}

// --- deciding ------------------------------------------------------------

/**
 * Applies a pending suggestion: re-validates `proposed`, claims the row with
 * a conditional UPDATE (the mutex against a second concurrent apply), then
 * writes through the existing library service and records the version
 * history. Any failure after the claim rolls the row back to 'pending' rather
 * than leaving it stuck 'applied' with nothing actually written.
 */
export async function applySuggestion(
  id: string,
  input: { expectedCurrentHash: string | null },
): Promise<LibrarySuggestionDto> {
  const row = await selectRow(id)
  if (!row) throw notFound('Suggestion')
  if (row.status !== 'pending') throw conflict(`Suggestion is ${row.status}, not pending`)

  // Re-validated before the claim: an invalid body must 400 without ever
  // flipping status, even transiently.
  const parsed = validateProposed(row.kind, row.name, row.proposed)
  const { name: _name, ...body } = parsed

  const [claimed] = await db
    .update(librarySuggestions)
    .set({ status: 'applied', decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(librarySuggestions.id, id), eq(librarySuggestions.status, 'pending')))
    .returning()
  if (!claimed) throw conflict('Suggestion is no longer pending')

  try {
    let appliedVersion: number
    const path = targetPath(row.kind, row.name)

    if (row.action === 'create') {
      if (row.kind === 'agent') {
        await createAgent({ name: row.name, ...(body as Omit<CreateAgentInput, 'name'>) })
      } else {
        await createSkill({ name: row.name, ...(body as Omit<CreateSkillInput, 'name'>) })
      }
      const writtenMarkdown = await readFile(path, 'utf8')
      appliedVersion = await recordVersion({
        kind: row.kind,
        name: row.name,
        preWriteMarkdown: null,
        writtenMarkdown,
        source: 'suggestion',
        suggestionId: row.id,
      })
    } else {
      const currentMarkdown = await readIfExists(path)
      if (currentMarkdown === null) {
        throw conflict(`${row.kind === 'agent' ? 'Agent' : 'Skill'} "${row.name}" no longer exists`)
      }
      if (input.expectedCurrentHash !== sha256Hex(currentMarkdown)) {
        throw conflict('This suggestion changed since you reviewed it — reload and try again')
      }
      if (row.kind === 'agent') {
        // No rename: `body` carries no `name`, so updateAgent leaves the
        // filename exactly where it was.
        await updateAgent(row.name, { ...(body as Omit<CreateAgentInput, 'name'>) })
      } else {
        await updateSkill(row.name, { name: row.name, ...(body as Omit<CreateSkillInput, 'name'>) })
      }
      const writtenMarkdown = await readFile(path, 'utf8')
      appliedVersion = await recordVersion({
        kind: row.kind,
        name: row.name,
        preWriteMarkdown: currentMarkdown,
        writtenMarkdown,
        source: 'suggestion',
        suggestionId: row.id,
      })
    }

    const [final] = await db
      .update(librarySuggestions)
      .set({ appliedVersion, updatedAt: new Date() })
      .where(eq(librarySuggestions.id, id))
      .returning()
    if (!final) throw new Error('Suggestion vanished mid-apply')
    return detailFromRow(final)
  } catch (error) {
    // Roll the claim back so the suggestion is still actionable — a failed
    // apply must not strand it 'applied' with nothing on disk to show for it.
    await db
      .update(librarySuggestions)
      .set({ status: 'pending', decidedAt: null, updatedAt: new Date() })
      .where(eq(librarySuggestions.id, id))
    throw error
  }
}

export async function rejectSuggestion(id: string): Promise<LibrarySuggestionDto> {
  const [row] = await db
    .update(librarySuggestions)
    .set({ status: 'rejected', decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(librarySuggestions.id, id), eq(librarySuggestions.status, 'pending')))
    .returning()
  if (row) return detailFromRow(row)

  const existing = await selectRow(id)
  if (!existing) throw notFound('Suggestion')
  throw conflict(`Suggestion is ${existing.status}, not pending`)
}

/**
 * Hard delete, only once rejected — this is what makes a rejected suggestion
 * "free to be proposed again": the job's own dedupe (round 2) only ever sees
 * rows that still exist, so removing this one is indistinguishable from it
 * never having been proposed at all.
 */
export async function deleteRejectedSuggestion(id: string): Promise<void> {
  const [row] = await db
    .delete(librarySuggestions)
    .where(and(eq(librarySuggestions.id, id), eq(librarySuggestions.status, 'rejected')))
    .returning({ id: librarySuggestions.id })
  if (row) return

  const existing = await selectRow(id)
  if (!existing) throw notFound('Suggestion')
  throw conflict(`Suggestion is ${existing.status}, not rejected`)
}
