import { z } from 'zod'

// The private key is never in this shape. It stays on disk at 0600 and the API
// has no endpoint that returns it — this service has no authentication, so the
// only safe answer is for the secret to be unreachable through it at all.
export const sshKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  comment: z.string().nullable(),
  publicKey: z.string().openapi({ description: 'Add this to the host as a deploy key' }),
  fingerprint: z.string(),
  lastTestedAt: z.string().nullable(),
  lastTestHost: z.string().nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestMessage: z.string().nullable(),
  createdAt: z.string(),
})
export type SshKeyDto = z.infer<typeof sshKeySchema>

export const createSshKeySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .openapi({ description: 'Filesystem-safe; becomes the key filename', example: 'github' }),
  comment: z.string().max(200).optional().openapi({
    description: 'Goes in ssh-keygen -C, conventionally an email',
    example: 'me@example.com',
  }),
})
export type CreateSshKeyInput = z.infer<typeof createSshKeySchema>

export const testSshKeySchema = z.object({
  // The value reaches ssh's argv, so it is shape-checked here as well as in the
  // service — a 400 naming the rule beats an ssh usage dump.
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^([A-Za-z0-9._-]+@)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, {
      message: 'Host must look like github.com or git@github.com',
    })
    .default('github.com')
    .openapi({ description: 'Host to try, e.g. github.com or gitlab.com' }),
})

export const testResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
})
