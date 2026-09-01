import { z } from 'zod'

// Mirrors the backend's rule: the name becomes a filename, so it is restricted
// to characters that are safe in one.
export const sshKeyFormSchema = z.object({
  name: z
    .string()
    .min(1, { message: 'sshKeys.form.errors.nameRequired' })
    .max(64, { message: 'sshKeys.form.errors.nameTooLong' })
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'sshKeys.form.errors.nameChars' }),
  comment: z.string().max(200).optional(),
})

export type SshKeyFormValues = z.infer<typeof sshKeyFormSchema>
