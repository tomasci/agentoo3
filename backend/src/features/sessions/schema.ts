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
  totalCostUsd: z.number(),
  pendingPrompts: z
    .number()
    .int()
    .openapi({ description: 'Messages sent while a turn was running, waiting their turn' }),
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

export const sessionMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  // Position in the transcript. Dense, gapless and unique per session, so a
  // reconnecting client asks for everything after the last seq it holds.
  seq: z.number().int(),
  type: z.string().openapi({
    description: "SDK message type, or 'prompt' for a message the human typed",
  }),
  // Set when the message came from inside a subagent, and equal to the
  // tool_use id of the Task call that started it. This is what nests the
  // transcript.
  parentToolUseId: z.string().nullable(),
  title: z.string().nullable().openapi({ description: 'Heading for the collapsed row' }),
  pending: z.boolean(),
  payload: z.unknown().openapi({ description: 'The SDK message, verbatim' }),
  createdAt: z.string(),
})
export type SessionMessageDto = z.infer<typeof sessionMessageSchema>

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(100_000),
})
export type SendMessageInput = z.infer<typeof sendMessageSchema>

// No zod schema for these: the export is assembled from already-parsed
// SessionDto/SessionMessageDto values, so a validation pass here would just be
// checking our own output. Types only.
export type SessionExportMessage = {
  seq: number
  type: string
  parentToolUseId: string | null
  title: string | null
  pending: boolean
  createdAt: string
  payload: unknown
}

export type SessionExport = {
  kind: 'agentoo.session-export'
  formatVersion: 1
  exportedAt: string
  generator: { app: 'agentoo'; version: string }
  session: {
    id: string
    projectId: string
    projectName: string
    title: string | null
    status: SessionDto['status']
    orchestrator: string | null
    branch: string | null
    isolated: boolean
    maxBudgetUsd: number | null
    totalCostUsd: number
    lastError: string | null
    messageCount: number
    createdAt: string
    updatedAt: string
  }
  messages: SessionExportMessage[]
}
