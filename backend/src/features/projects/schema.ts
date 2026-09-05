import { z } from 'zod'
import { checkBranchName } from '@/lib/branch-name'

export const projectStatusSchema = z.enum(['pending', 'cloning', 'ready', 'needs_manual', 'failed'])

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  source: z.enum(['clone', 'existing', 'empty']),
  remoteUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  sshKeyId: z.string().uuid().nullable(),
  defaultBranch: z.string().nullable(),
  status: projectStatusSchema,
  lastError: z.string().nullable(),
  recoveryCommands: z.array(z.string()).nullable(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProjectDto = z.infer<typeof projectSchema>

// Exactly one source. `sourceName` is a folder name inside SOURCES_DIR, never a
// path — adoption is restricted to that directory by construction.
export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    remoteUrl: z.string().min(1).optional(),
    sourceName: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: 'Folder name inside SOURCES_DIR to adopt' }),
    empty: z
      .boolean()
      .optional()
      .openapi({ description: 'Create an empty git repository instead' }),
    sshKeyId: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: 'Clone using this SSH key. Needed for a private repo over ssh.' }),
  })
  .refine((v) => [v.remoteUrl, v.sourceName, v.empty].filter(Boolean).length === 1, {
    message: 'Provide exactly one of remoteUrl, sourceName or empty',
  })
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const errorSchema = z.object({
  error: z.string(),
  recoveryCommands: z.array(z.string()).optional(),
})

// Everything here is optional: a PATCH that only swaps the ssh key should not
// have to restate the name. `sshKeyId: null` clears it back to ssh defaults,
// and `defaultBranch: null` clears it back to auto-detect (the repo's current
// branch at the time each session starts), which is why both are nullable
// rather than merely optional.
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    remoteUrl: z.string().min(1).optional(),
    sshKeyId: z.string().uuid().nullable().optional(),
    defaultBranch: z
      .string()
      .nullable()
      .optional()
      .refine((v) => v === undefined || v === null || checkBranchName(v).ok, {
        // See createSessionSchema.baseBranch for why this is a function
        // rather than the static messages the other fields here use.
        error: (issue) => {
          if (issue.input === null) return undefined
          const check = checkBranchName(String(issue.input))
          return check.ok ? undefined : check.reason
        },
      })
      .openapi({
        description:
          'Branch new session worktrees are cut from by default, brought up to date from the ' +
          'remote immediately before each one is cut. Not checked for existence here — a branch ' +
          'may legitimately not exist locally yet — only when a session actually starts.',
      }),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
