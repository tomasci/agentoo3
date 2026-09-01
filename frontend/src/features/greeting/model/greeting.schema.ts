import { z } from 'zod'

// Message keys rather than sentences: the form renders them through i18next,
// so validation text is translated like everything else.
export const greetingSchema = z.object({
  name: z
    .string()
    .min(2, { message: 'greeting.errors.tooShort' })
    .max(40, { message: 'greeting.errors.tooLong' }),
})

export type GreetingValues = z.infer<typeof greetingSchema>
