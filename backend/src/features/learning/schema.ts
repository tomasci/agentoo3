// Wire shapes for /library/learning and /library/suggestions — mirrors
// db/schema.ts's learning_runs/library_suggestions/library_item_versions,
// the same "wire-shape file beside the service that fills it in" split every
// other feature here already uses.

import { z } from '@hono/zod-openapi'
import { libraryKindEnum } from '@/db/schema'
import { learningScheduleSchema } from './schedule'

// --- runs --------------------------------------------------------------------

export const learningRunTriggerSchema = z.enum(['scheduled', 'manual'])
export const learningRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])

export const learningRunSchema = z
  .object({
    id: z.string().uuid(),
    trigger: learningRunTriggerSchema,
    status: learningRunStatusSchema,
    windowStart: z.string().openapi({ description: 'ISO timestamp: windowEnd minus 24h' }),
    windowEnd: z.string().openapi({ description: 'ISO timestamp: the session window reviewed' }),
    sessionsAnalyzed: z.number().int(),
    suggestionsCreated: z.number().int(),
    duplicatesSkipped: z.number().int().openapi({
      description: 'Proposals the job generated but matched an existing pending suggestion',
    }),
    costUsd: z.number(),
    error: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .openapi('LearningRun')
export type LearningRunDto = z.infer<typeof learningRunSchema>

export const learningOverviewSchema = z
  .object({
    schedule: z.object({
      value: learningScheduleSchema,
      nextRunAt: z.string().nullable().openapi({
        description: 'ISO timestamp of the next scheduled run, null when disabled',
      }),
    }),
    activeRun: learningRunSchema
      .nullable()
      .openapi({ description: "status 'queued' or 'running'" }),
    lastRun: learningRunSchema
      .nullable()
      .openapi({ description: 'Most recent finished run, if any' }),
    recentRuns: z.array(learningRunSchema).openapi({ description: 'Up to 10, newest first' }),
  })
  .openapi('LearningOverview')
export type LearningOverviewDto = z.infer<typeof learningOverviewSchema>

// --- suggestions ---------------------------------------------------------

export const librarySuggestionKindSchema = z.enum(libraryKindEnum.enumValues)
export const librarySuggestionActionSchema = z.enum(['create', 'modify'])
export const librarySuggestionStatusSchema = z.enum(['pending', 'applied', 'rejected'])

export const learningSourceSessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    projectId: z.string().uuid(),
    projectName: z.string(),
  })
  .openapi('LearningSourceSession')

export const librarySuggestionSummarySchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid().nullable(),
    kind: librarySuggestionKindSchema,
    action: librarySuggestionActionSchema,
    name: z.string(),
    title: z.string(),
    rationale: z.string(),
    status: librarySuggestionStatusSchema,
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
    appliedVersion: z.number().int().nullable(),
    sourceSessions: z.array(learningSourceSessionSchema).openapi({
      description: 'Only sessions that still exist — a cited session may since have been deleted',
    }),
    targetExists: z.boolean().openapi({
      description:
        "'modify': whether the target still exists; 'create': false unless the name is now taken",
    }),
    stale: z.boolean().openapi({
      description: "'modify' only: whether the live markdown has changed since baseMarkdown",
    }),
  })
  .openapi('LibrarySuggestionSummary')
export type LibrarySuggestionSummaryDto = z.infer<typeof librarySuggestionSummarySchema>

export const librarySuggestionSchema = librarySuggestionSummarySchema
  .extend({
    proposed: z.record(z.string(), z.unknown()).openapi({
      description:
        "The structured proposed body, exactly createAgentSchema/createSkillSchema minus 'name'",
    }),
    proposedMarkdown: z.string().openapi({ description: 'What applying this would write' }),
    baseMarkdown: z.string().nullable().openapi({
      description: "'modify': the target's full markdown at proposal time; null for 'create'",
    }),
    currentMarkdown: z.string().nullable().openapi({
      description: "The live target's markdown right now; null for 'create' or a deleted target",
    }),
    currentHash: z.string().nullable().openapi({
      description: 'sha256 hex of currentMarkdown; null exactly when currentMarkdown is null',
    }),
  })
  .openapi('LibrarySuggestion')
export type LibrarySuggestionDto = z.infer<typeof librarySuggestionSchema>

export const listSuggestionsQuerySchema = z.object({
  status: librarySuggestionStatusSchema.default('pending').openapi({
    param: { name: 'status', in: 'query' },
  }),
})

export const applySuggestionSchema = z
  .object({
    expectedCurrentHash: z
      .string()
      .nullable()
      .openapi({
        description:
          "The currentHash this suggestion's detail view showed when reviewed. For 'modify', a " +
          "mismatch against the live file's hash right now is a 409 — this is what guarantees the " +
          "diff the reviewer saw is exactly what gets applied. Ignored for 'create'.",
      }),
  })
  .openapi('ApplyLibrarySuggestion')
export type ApplySuggestionInput = z.infer<typeof applySuggestionSchema>

// --- version history -------------------------------------------------------

export const libraryVersionSourceSchema = z.enum(['snapshot', 'suggestion'])

export const libraryItemVersionSchema = z
  .object({
    version: z.number().int(),
    source: libraryVersionSourceSchema,
    suggestionId: z.string().uuid().nullable(),
    createdAt: z.string(),
    markdown: z.string(),
  })
  .openapi('LibraryItemVersion')
export type LibraryItemVersionDto = z.infer<typeof libraryItemVersionSchema>
