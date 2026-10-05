import { z } from 'zod'
import type { ScheduleKind } from '../lib/schedule'

// Mirrors the backend's own validation (its `createAutomationSchema`): name
// 1–200 chars with no control characters, prompt 1–100000 chars, orchestrator
// required. Unlike `createIdeaFormSchema`'s identical fields, this schema is
// not handed to `zodResolver` — see `AutomationFormDialog`'s own comment for
// why this form stays plain `useState` + a manual `safeParse` on submit, the
// same choice `idea-canvas.tsx`'s `BlockDialog` makes for the identical
// reason (a "kind" selector — here, the schedule's own preset kind — reshapes
// which of the rest of the fields apply).

// A charCodeAt loop rather than a `/[\u0000-\u001f]/`-shaped regex, which
// biome's noControlCharactersInRegex rule refuses outright — same choice
// `features/env-files/lib/path-rules.ts`'s own `hasControlChars` makes for
// the identical problem (there, mirroring the backend's C0 *and* C1 check;
// here, just the backend's own `createAutomationSchema` rule, C0 plus DEL).
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const nameSchema = z
  .string()
  .trim()
  .min(1, { message: 'automations.form.errors.nameRequired' })
  .max(200, { message: 'automations.form.errors.nameTooLong' })
  .refine((value) => !hasControlChars(value), {
    message: 'automations.form.errors.nameInvalid',
  })

const promptSchema = z
  .string()
  .min(1, { message: 'automations.form.errors.promptRequired' })
  .max(100000, { message: 'automations.form.errors.promptTooLong' })

const orchestratorSchema = z
  .string()
  .trim()
  .min(1, { message: 'automations.form.errors.orchestratorRequired' })
  .max(64, { message: 'automations.form.errors.orchestratorTooLong' })

const baseBranchSchema = z.string().trim().optional()

// Same bounds as `createIdeaFormSchema.shape.maxBudgetUsd` (the backend's own
// `maxBudgetUsd` constraint is identical on both DTOs).
const maxBudgetUsdSchema = z
  .number({ message: 'automations.form.errors.budgetInvalid' })
  .int({ message: 'automations.form.errors.budgetInvalid' })
  .positive({ message: 'automations.form.errors.budgetInvalid' })
  .max(1000, { message: 'automations.form.errors.budgetTooHigh' })
  .optional()

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
  message: 'automations.form.errors.timeInvalid',
})

const scheduleKinds: [ScheduleKind, ...ScheduleKind[]] = [
  'daily',
  'weekdays',
  'weekends',
  'days',
  'hourly',
  'custom',
]

export const automationFormSchema = z
  .object({
    name: nameSchema,
    prompt: promptSchema,
    scheduleKind: z.enum(scheduleKinds),
    time: timeSchema,
    days: z.array(z.number().int().min(0).max(6)),
    everyHours: z.number().int().min(1).max(12),
    minute: z.number().int().min(0).max(59),
    customCron: z.string().trim().max(100, {
      message: 'automations.form.errors.cronTooLong',
    }),
    timezone: z.string().min(1, { message: 'automations.form.errors.timezoneRequired' }),
    orchestrator: orchestratorSchema,
    baseBranch: baseBranchSchema,
    maxBudgetUsd: maxBudgetUsdSchema,
    /** Create only — see `AutomationFormDialog`'s own comment. */
    startPaused: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.scheduleKind === 'days' && values.days.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['days'],
        message: 'automations.form.errors.daysRequired',
      })
    }
    if (values.scheduleKind === 'custom' && values.customCron.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['customCron'],
        message: 'automations.form.errors.cronRequired',
      })
    }
  })

export type AutomationFormValues = z.infer<typeof automationFormSchema>
