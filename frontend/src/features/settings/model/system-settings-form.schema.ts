import { z } from 'zod'

// Mirrors the backend's rule for this same key (backend's features/system/
// schema.ts, maxConcurrentSessionsSchema): a whole number, 1 through 64. The
// upper bound is a typo guard there, not a real ceiling on concurrency, so it
// is worth mirroring here rather than letting a client-side submit round-trip
// to the server just to find that out.
export const systemSettingsFormSchema = z.object({
  maxConcurrentSessions: z
    .number({ message: 'settings.errors.maxConcurrentSessionsInvalid' })
    .int({ message: 'settings.errors.maxConcurrentSessionsInvalid' })
    .min(1, { message: 'settings.errors.maxConcurrentSessionsInvalid' })
    .max(64, { message: 'settings.errors.maxConcurrentSessionsTooHigh' }),
})
export type SystemSettingsFormValues = z.infer<typeof systemSettingsFormSchema>
