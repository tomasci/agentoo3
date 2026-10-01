import { z } from 'zod'

// Mirrors the backend's own `LearningSchedule` shape and its `time` pattern
// (see the generated type's own `@pattern`) — a client-side reject here saves
// a round trip for the one mistake a time-of-day field invites: typing
// something that isn't HH:MM at all.
export const learningScheduleFormSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'settings.errors.learningTimeInvalid',
  }),
  timezone: z.string().min(1, { message: 'settings.errors.learningTimezoneInvalid' }),
})
export type LearningScheduleFormValues = z.infer<typeof learningScheduleFormSchema>
