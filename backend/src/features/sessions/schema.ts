import { z } from 'zod'
import { sessionFileStatusSchema } from '@/features/attachments/schema'
import { checkBranchName } from '@/lib/branch-name'

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
  ideaId: z
    .string()
    .uuid()
    .nullable()
    .openapi({
      description:
        'The idea this session was handed off from — set on ideas.session_id at handoff, ' +
        'joined in the reverse direction (see that column in db/schema.ts). Null for a session ' +
        'created directly, without an idea behind it.',
    }),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  orchestrator: z.string().nullable(),
  // Null when the project is not a git repository: those sessions share the
  // project directory instead, and the UI says so.
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z
    .string()
    .nullable()
    .openapi({ description: "Branch this session's worktree was cut from, or null without one" }),
  baseSha: z.string().nullable().openapi({ description: 'Commit the worktree started from' }),
  baseNote: z
    .string()
    .nullable()
    .openapi({
      description:
        'Set when the base branch could not be brought up to date before this session started ' +
        '(no remote, network down, rejected key, missing branch on the remote, ...); the session ' +
        'still started, from whatever the local branch already had',
    }),
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
  settledAt: z
    .string()
    .nullable()
    .openapi({
      description:
        'When a turn last ended with a result for the operator to look at — set by every write ' +
        "that moves status to 'completed', 'failed' or 'interrupted'. Null for a session that " +
        'has never settled, including every session created before this field existed (no ' +
        'backfill — see "Unchecked results" in backend/README.md).',
    }),
  seenAt: z
    .string()
    .nullable()
    .openapi({
      description:
        'When the operator last opened this session (POST /sessions/{id}/seen). Null if never ' +
        'opened, including every session created before this field existed.',
    }),
  unchecked: z.boolean().openapi({
    description:
      'A result is waiting that the operator has not looked at: settledAt is set, status is ' +
      'not queued or running, and seenAt is null or older than settledAt.',
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SessionDto = z.infer<typeof sessionSchema>

/**
 * A window the "recent" list of the sessions overview looks back over. Its
 * own schema, not inlined at the route: getSessionsOverview (service.ts)
 * takes this exact type, so the query-param validator and the service
 * signature cannot drift apart on what counts as a legal window.
 */
export const sessionsOverviewWindowSchema = z.enum(['1d', '3d', '7d'])
export type SessionsOverviewWindow = z.infer<typeof sessionsOverviewWindowSchema>

/**
 * A SessionDto plus which project it belongs to — the overview spans every
 * project at once, unlike every other session endpoint, which is already
 * scoped to one. Named via `.openapi('OverviewSession', ...)` (rather than
 * left inline like the rest of this file's schemas) so kubb emits it as one
 * shared type instead of three structurally-identical inline ones, one per
 * list below.
 */
export const overviewSessionSchema = sessionSchema
  .extend({ projectName: z.string() })
  .openapi('OverviewSession', {
    description: 'A session, plus the name of the project it belongs to.',
  })
export type OverviewSessionDto = z.infer<typeof overviewSessionSchema>

export const sessionsOverviewSchema = z.object({
  running: z.array(overviewSessionSchema).openapi({
    description:
      "status in ('running', 'queued'), across every project, newest activity first. Not " +
      'limited by window.',
  }),
  unchecked: z.array(overviewSessionSchema).openapi({
    description:
      'unchecked === true (see SessionDto.unchecked), newest result first. Not limited by window.',
  }),
  recent: z.array(overviewSessionSchema).openapi({
    description:
      'updatedAt within window, every status, newest first, capped at 200 rows. May repeat a ' +
      'session already listed under running or unchecked — that overlap is intended.',
  }),
  window: sessionsOverviewWindowSchema,
})
export type SessionsOverviewDto = z.infer<typeof sessionsOverviewSchema>

/**
 * A role:orchestrator agent's name, shared between create and update.
 *
 * `.trim()` runs before `.min(1)`, so a whitespace-only value ("   ", or a
 * stray "\t\n ") fails the length check the same as an empty string instead
 * of slipping through as "non-empty" — sendMessage's own guard further down
 * this feature only checks truthiness, so a session that reached this schema
 * with an orchestrator that is technically a non-empty string but entirely
 * whitespace would never be caught there, and would run with a blank one.
 * The trim is also what makes a value like "  lead  " persist as "lead"
 * rather than whatever whitespace the client happened to send.
 */
const orchestratorName = z.string().trim().min(1).max(64)

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  // Required, not optional: a session with no orchestrator can never run a
  // turn (sendMessage's own guard, service.ts), so refusing to create one is
  // cheaper than creating a session that can only ever 400 on its first
  // message.
  orchestrator: orchestratorName.openapi({
    description: 'Name of a role:orchestrator agent from the library',
  }),
  maxBudgetUsd: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .openapi({ description: 'Hard spend cap for this session, passed to the SDK' }),
  baseBranch: z
    .string()
    .optional()
    .refine((v) => v === undefined || checkBranchName(v).ok, {
      // `error` rather than the static `message` used elsewhere in this
      // file: it is only invoked once the refine above has already failed,
      // so recomputing checkBranchName here is what surfaces the specific
      // reason ("may not start with -", "is too long", ...) to the client
      // instead of a generic "Invalid input".
      error: (issue) => {
        const check = checkBranchName(String(issue.input))
        return check.ok ? undefined : check.reason
      },
    })
    .openapi({
      description:
        "Cut this session's worktree from this branch instead of the project default, for " +
        'this session only. Never written back to the project.',
    }),
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>

export const updateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    // Optional (may be left unchanged) but, unlike create, not nullable: a
    // session that already has an orchestrator must not be able to lose it
    // through an update, only swap it for another one.
    orchestrator: orchestratorName.optional(),
    maxBudgetUsd: z.number().int().positive().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>

/** One attachment a message carried, resolved from message_files joined to
 * session_files — see message_files in db/schema.ts for why id can be null. */
export const messageFileSchema = z.object({
  id: z
    .string()
    .uuid()
    .nullable()
    .openapi({
      description:
        "Null once this file's row has been hard-deleted (storage cleanup can remove a " +
        'dangling_row or a checksum_mismatch outright) — the message still records that a file ' +
        'was here even though there is nothing left to fetch it by',
    }),
  originalFilename: z
    .string()
    .nullable()
    .openapi({
      description:
        'The name at announcement time, kept even after the file row is gone. Null only for a ' +
        'link written before this field existed, whose file has since also disappeared.',
    }),
  mimeType: z.string().nullable().openapi({ description: 'Null when id is null — see id' }),
  sizeBytes: z.number().int().nullable().openapi({ description: 'Null when id is null — see id' }),
  status: sessionFileStatusSchema
    .nullable()
    .openapi({ description: 'Null when id is null — see id' }),
})
export type MessageFileDto = z.infer<typeof messageFileSchema>

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
  files: z.array(messageFileSchema).openapi({
    description:
      "Attachments this prompt's announcement carried, empty for every message that is not " +
      'the one that first announced a file — see message_files in db/schema.ts',
  }),
  createdAt: z.string(),
})
export type SessionMessageDto = z.infer<typeof sessionMessageSchema>

// A backward page is always handed back ascending, same as the after-mode
// (whole-transcript) response — one ordering for the whole endpoint, so a
// client never re-sorts depending on which cursor it used.
export const messagePageSchema = z.object({
  messages: z.array(sessionMessageSchema),
  hasOlder: z.boolean().openapi({
    description:
      'Whether messages exist below the oldest one in this page, i.e. there is another ' +
      'backward page to fetch with before=messages[0].seq. Computed honestly for both bounded ' +
      'modes — a before page, and limit alone for an initial load — and always false for the ' +
      'unbounded after response (including the whole-transcript default), since nothing is held ' +
      'back there for this flag to report on.',
  }),
})
export type SessionMessagePageDto = z.infer<typeof messagePageSchema>

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
