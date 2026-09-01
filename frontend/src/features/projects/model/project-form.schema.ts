import { z } from 'zod'

// Mirrors the backend's rule: exactly one source. Validating here too lets the
// form say so before a request, and the backend still refuses anything that
// gets past it.
export const projectFormSchema = z
  .object({
    name: z.string().min(1, { message: 'projects.form.errors.nameRequired' }).max(120),
    source: z.enum(['clone', 'existing', 'empty']),
    remoteUrl: z.string().trim().optional(),
    // A folder name inside the sources directory, chosen from a list — never a
    // path typed by hand, so there is nothing to validate for traversal here.
    sourceName: z.string().optional(),
    // '' means "use ssh defaults"; the API wants the field absent, not empty.
    sshKeyId: z.string().optional(),
  })
  .refine((v) => v.source !== 'clone' || Boolean(v.remoteUrl), {
    message: 'projects.form.errors.remoteRequired',
    path: ['remoteUrl'],
  })
  .refine((v) => v.source !== 'existing' || Boolean(v.sourceName), {
    message: 'projects.form.errors.folderRequired',
    path: ['sourceName'],
  })

export type ProjectFormValues = z.infer<typeof projectFormSchema>
