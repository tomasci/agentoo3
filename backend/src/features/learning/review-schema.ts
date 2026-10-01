// Wire shapes for the two structured-output model calls the engine makes —
// the per-batch review call and the dedupe judge call (features/learning/
// engine.ts, dedupe.ts). Both a zod schema (what actually gets trusted — see
// this round's own brief: "never trust the steer") and a JSON Schema mirror
// (handed to the SDK as `outputFormat`, a strong hint the model is steered
// toward, never an enforcement) exist for each, the same split
// features/ideas/prompt-service.ts already uses for its own answer shape.

import { z } from 'zod'

// --- the review call: proposed library changes ------------------------------

export const reviewCandidateSchema = z.object({
  kind: z.enum(['agent', 'skill']),
  action: z.enum(['create', 'modify']),
  name: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  sourceSessionIds: z.array(z.string()),
  // Loose on purpose: features/learning/candidates.ts re-validates this
  // against the real createAgentSchema/createSkillSchema (minus `name`) once
  // `kind` is known, the same two-stage validation insertSuggestion already
  // does for a human-reviewed suggestion.
  proposed: z.record(z.string(), z.unknown()),
})
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>

export const reviewAnswerSchema = z.object({
  suggestions: z.array(reviewCandidateSchema),
})
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>

export const REVIEW_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['agent', 'skill'] },
          action: { type: 'string', enum: ['create', 'modify'] },
          name: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 },
          sourceSessionIds: { type: 'array', items: { type: 'string' } },
          proposed: { type: 'object' },
        },
        required: ['kind', 'action', 'name', 'title', 'rationale', 'sourceSessionIds', 'proposed'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
}

// --- the dedupe judge call ---------------------------------------------------

export const dedupeJudgeAnswerSchema = z.object({
  results: z.array(
    z.object({
      candidateIndex: z.number().int().min(0),
      duplicateOfId: z.string().nullable(),
      reason: z.string(),
    }),
  ),
})
export type DedupeJudgeAnswer = z.infer<typeof dedupeJudgeAnswerSchema>

export const DEDUPE_JUDGE_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateIndex: { type: 'integer', minimum: 0 },
          duplicateOfId: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['candidateIndex', 'duplicateOfId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}
