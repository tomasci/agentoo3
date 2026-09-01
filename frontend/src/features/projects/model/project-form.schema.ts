import { z } from 'zod'

// Mirrors the backend's own rule: exactly one source. Validating here too lets
// the form say so before a request, and the backend still refuses anything that
// gets past it.
export const projectFormSchema = z
  .object({
    name: z.string().min(1, { message: 'projects.form.errors.nameRequired' }).max(120),
    source: z.enum(['clone', 'existing']),
    remoteUrl: z.string().trim().optional(),
    existingPath: z.string().trim().optional(),
    // '' means "use ssh defaults"; the API wants the field absent, not empty.
    sshKeyId: z.string().optional(),
  })
  .refine((v) => v.source !== 'clone' || Boolean(v.remoteUrl), {
    message: 'projects.form.errors.remoteRequired',
    path: ['remoteUrl'],
  })
  .refine((v) => v.source !== 'existing' || Boolean(v.existingPath), {
    message: 'projects.form.errors.pathRequired',
    path: ['existingPath'],
  })
  .refine((v) => v.source !== 'existing' || (v.existingPath ?? '').startsWith('/'), {
    message: 'projects.form.errors.pathAbsolute',
    path: ['existingPath'],
  })

export type ProjectFormValues = z.infer<typeof projectFormSchema>
