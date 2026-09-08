import { z } from 'zod'
import { IDEA_STATUSES } from '../lib/status'

// Mirrors the backend's rule (backend's features/ideas/schema.ts,
// `createIdeaSchema`): title is required, everything else optional.
// `baseBranch`'s own grammar (`checkBranchName`, backend's lib/branch-name.ts)
// is not repeated here, the same choice `sessions/components/project-
// sessions.tsx`'s creation form makes for the identical field: the backend
// owns that check, and a rejected value comes back through `apiErrorMessage`
// naming the specific rule it broke rather than a client-side guess at it.
export const createIdeaFormSchema = z.object({
  title: z
    .string()
    .min(1, { message: 'ideas.form.errors.titleRequired' })
    .max(300, { message: 'ideas.form.errors.titleTooLong' }),
  // Which column the card starts in. Left unset to default to backlog, the
  // same default the backend applies when this is omitted from the request.
  status: z.enum(IDEA_STATUSES).optional(),
  orchestrator: z
    .string()
    .trim()
    .max(64, { message: 'ideas.form.errors.orchestratorTooLong' })
    .optional(),
  baseBranch: z.string().trim().optional(),
  maxBudgetUsd: z
    .number({ message: 'ideas.form.errors.budgetInvalid' })
    .int({ message: 'ideas.form.errors.budgetInvalid' })
    .positive({ message: 'ideas.form.errors.budgetInvalid' })
    .max(1000, { message: 'ideas.form.errors.budgetTooHigh' })
    .optional(),
})
export type CreateIdeaFormValues = z.infer<typeof createIdeaFormSchema>

// Mirrors `updateIdeaSchema`: every field optional, and `orchestrator`/
// `baseBranch`/`maxBudgetUsd` may be `null` — the API's own way of clearing a
// field back to nothing (that schema's identical `nullable().optional()` on
// each) — but `title` can never be cleared, so it stays plain `optional()`,
// never `nullable()`. Reuses `createIdeaFormSchema`'s own field schemas
// rather than repeating their constraints, so the two can never quietly
// drift apart. No "at least one field" refine, unlike the backend's own
// schema: that rule is about a partial PATCH body having something in it,
// which is this feature's mutation caller's job to decide (by diffing
// against the loaded idea) before it ever builds one, not something the full,
// always-populated edit form itself should refuse to submit.
export const updateIdeaFormSchema = z.object({
  title: createIdeaFormSchema.shape.title.optional(),
  orchestrator: createIdeaFormSchema.shape.orchestrator.nullable(),
  baseBranch: createIdeaFormSchema.shape.baseBranch.nullable(),
  maxBudgetUsd: createIdeaFormSchema.shape.maxBudgetUsd.nullable(),
})
export type UpdateIdeaFormValues = z.infer<typeof updateIdeaFormSchema>
