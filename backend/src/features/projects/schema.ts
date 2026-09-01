import { z } from 'zod'

export const projectStatusSchema = z.enum(['pending', 'cloning', 'ready', 'needs_manual', 'failed'])

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  source: z.enum(['clone', 'existing']),
  remoteUrl: z.string().nullable(),
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

// Either clone a remote or adopt a directory — never both, never neither.
export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    remoteUrl: z.string().min(1).optional(),
    existingPath: z.string().min(1).optional(),
    sshKeyId: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: 'Clone using this SSH key. Needed for a private repo over ssh.' }),
  })
  .refine((v) => Boolean(v.remoteUrl) !== Boolean(v.existingPath), {
    message: 'Provide exactly one of remoteUrl or existingPath',
  })
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const errorSchema = z.object({
  error: z.string(),
  recoveryCommands: z.array(z.string()).optional(),
})
