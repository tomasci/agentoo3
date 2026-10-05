// Wire shapes for project automations — mirrors db/schema.ts's
// automations/automation_runs, the same "wire-shape file beside the service
// that fills it in" split every other feature here already uses.

import { z } from '@hono/zod-openapi'
import { automationRunStatusEnum } from '@/db/schema'
import { orchestratorName, sessionStatusSchema } from '@/features/sessions/schema'
import { checkBranchName } from '@/lib/branch-name'
import { hasControlChars } from '@/lib/text'
import { isKnownTimeZone } from '@/lib/time-zone'
import { validateCron } from './cron'

export const automationRunStatusSchema = z.enum(automationRunStatusEnum.enumValues)

// --- shared field rules, reused across create/update/preview ----------------

/** Trimmed, 1..200 chars, no control characters — the same shape every other
 * free-text "title" field in this app enforces (see ideaSchema's own `title`
 * for the closest sibling), plus the control-character check every operator
 * string that ends up in a title or filename elsewhere in this codebase
 * already gets. */
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !hasControlChars(v), { message: 'Name contains control characters' })

/** 1..100_000 chars, not blank after trim — same ceiling as
 * sendMessageSchema's own `text` (features/sessions/schema.ts), since this is
 * the identical kind of value: free text handed straight to a session as its
 * opening prompt. `min(1)` alone would accept a whitespace-only string. */
const promptSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((v) => v.trim() !== '', { message: 'Prompt must not be blank' })

const cronFieldSchema = z.string().min(1).max(100)

const timezoneSchema = z.string().refine(isKnownTimeZone, 'Unknown IANA time zone')

const maxBudgetUsdSchema = z.number().int().positive().max(1000)

/**
 * Validate `cron`+`timezone` together, once both are known — called from
 * create (where both are required) and from update only when a request
 * supplies both at once; a patch that only changes one of the pair is
 * re-validated against the *stored* value of the other by the service layer
 * (features/automations/service.ts), which is the only place that actually
 * knows what the other one currently is.
 */
function addCronIssue(ctx: z.RefinementCtx, cron: string, timezone: string): void {
  const result = validateCron(cron, timezone)
  if (!result.valid) {
    ctx.addIssue({
      code: 'custom',
      path: ['cron'],
      message: result.error ?? 'Invalid cron schedule',
    })
  }
}

// --- automations: CRUD -------------------------------------------------------

export const automationSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    name: z.string(),
    prompt: z.string(),
    cron: z.string().openapi({ description: 'A standard 5-field cron expression' }),
    timezone: z.string().openapi({ description: 'IANA zone `cron` is evaluated in' }),
    paused: z.boolean().openapi({
      description: 'Never fires while true. Editable, and stays visible, regardless.',
    }),
    orchestrator: z.string().openapi({ description: 'Name of a role:orchestrator agent' }),
    baseBranch: z.string().nullable(),
    maxBudgetUsd: z.number().int().nullable(),
    nextRunAt: z.string().nullable().openapi({
      description: 'The next due instant, ISO — null exactly while paused',
    }),
    lastRunAt: z.string().nullable().openapi({
      description: 'The scheduled instant of the most recent firing, ISO — null before the first',
    }),
    runCount: z.number().int().openapi({ description: 'How many times this has ever fired' }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Automation')
export type AutomationDto = z.infer<typeof automationSchema>

export const createAutomationSchema = z
  .object({
    name: nameSchema,
    prompt: promptSchema,
    cron: cronFieldSchema,
    timezone: timezoneSchema,
    paused: z.boolean().optional().openapi({ description: 'Defaults to false — created running' }),
    orchestrator: orchestratorName.openapi({
      description: 'Name of a role:orchestrator agent from the library',
    }),
    // Same rule as createSessionSchema.baseBranch (features/sessions/schema.ts)
    // — see that field's own comment for why `error` is computed rather than
    // a static message.
    baseBranch: z
      .string()
      .optional()
      .refine((v) => v === undefined || checkBranchName(v).ok, {
        error: (issue) => {
          const check = checkBranchName(String(issue.input))
          return check.ok ? undefined : check.reason
        },
      })
      .openapi({
        description:
          "Cut this automation's session worktree from this branch instead of the project " +
          'default, each time it fires.',
      }),
    maxBudgetUsd: maxBudgetUsdSchema.optional().openapi({
      description: 'Hard spend cap passed to each session this automation creates',
    }),
  })
  .superRefine((data, ctx) => addCronIssue(ctx, data.cron, data.timezone))
  .openapi('CreateAutomation')
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>

export const updateAutomationSchema = z
  .object({
    name: nameSchema.optional(),
    prompt: promptSchema.optional(),
    cron: cronFieldSchema.optional(),
    timezone: timezoneSchema.optional(),
    paused: z.boolean().optional(),
    orchestrator: orchestratorName.optional(),
    // Same reasoning as updateIdeaSchema.baseBranch (features/ideas/schema.ts):
    // nullable so a PATCH can clear it back to the project default.
    baseBranch: z
      .string()
      .nullable()
      .optional()
      .refine((v) => v === undefined || v === null || checkBranchName(v).ok, {
        error: (issue) => {
          if (issue.input === null) return undefined
          const check = checkBranchName(String(issue.input))
          return check.ok ? undefined : check.reason
        },
      }),
    maxBudgetUsd: maxBudgetUsdSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .superRefine((data, ctx) => {
    // Only checked here when both are given in the same request — the
    // common "editing the schedule" case. A patch touching just one of the
    // pair is re-validated by the service against the stored value of the
    // other, which is the only place that knows it.
    if (data.cron !== undefined && data.timezone !== undefined) {
      addCronIssue(ctx, data.cron, data.timezone)
    }
  })
  .openapi('UpdateAutomation')
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>

// --- runs: read-only here — created and closed by the sweep -----------------

/** Just enough of the run's session for the UI to show it inline — never the
 * full SessionDto, the same restraint UncheckedSessionHead (sessions/schema's
 * sibling, sessions/service.ts) already applies for an identical reason. */
export const automationRunSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  totalCostUsd: z.number(),
  unchecked: z.boolean(),
})

export const automationRunSchema = z
  .object({
    id: z.string().uuid(),
    automationId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    scheduledFor: z.string().openapi({ description: 'The cron occurrence this run fired for' }),
    startedAt: z.string(),
    status: automationRunStatusSchema,
    error: z.string().nullable(),
    prompt: z.string().openapi({ description: 'Snapshot of the prompt actually sent' }),
    session: automationRunSessionSchema.nullable().openapi({
      description:
        'Null when dispatch failed before a session ever existed, or the session was later deleted',
    }),
  })
  .openapi('AutomationRun')
export type AutomationRunDto = z.infer<typeof automationRunSchema>

export const listAutomationRunsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, description: 'Default 100, max 500' }),
})

// --- schedule preview ---------------------------------------------------------

export const schedulePreviewRequestSchema = z
  .object({
    cron: cronFieldSchema,
    timezone: timezoneSchema,
    count: z.number().int().min(1).max(10).optional().openapi({ description: 'Default 5' }),
  })
  .openapi('SchedulePreviewRequest')
export type SchedulePreviewInput = z.infer<typeof schedulePreviewRequestSchema>

export const schedulePreviewSchema = z
  .object({
    valid: z.boolean(),
    error: z.string().nullable(),
    nextRuns: z.array(z.string()).openapi({ description: 'ISO timestamps, empty when invalid' }),
  })
  .openapi('SchedulePreview')
export type SchedulePreviewDto = z.infer<typeof schedulePreviewSchema>
