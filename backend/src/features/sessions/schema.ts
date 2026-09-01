import { z } from 'zod'

export const sessionStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
])

export const sessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  orchestrator: z.string().nullable(),
  // Null when the project is not a git repository: those sessions share the
  // project directory instead, and the UI says so.
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  // Where an agent would actually run, worktree or shared checkout.
  workingDir: z.string(),
  isolated: z.boolean().openapi({ description: 'False when sessions share the project directory' }),
  sdkSessionId: z.string().nullable(),
  maxBudgetUsd: z.number().int().nullable(),
  lastError: z.string().nullable(),
  messageCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SessionDto = z.infer<typeof sessionSchema>

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  orchestrator: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .openapi({ description: 'Name of a role:orchestrator agent from the library' }),
  maxBudgetUsd: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .openapi({ description: 'Hard spend cap for this session, passed to the SDK' }),
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>

export const updateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    orchestrator: z.string().min(1).max(64).nullable().optional(),
    maxBudgetUsd: z.number().int().positive().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>
