import { z } from 'zod'

// Mirrors the backend's own rule for a git identity (backend's features/
// projects/schema.ts, gitIdentityInputSchema): both fields required and
// trimmed, name 1-200 chars, email 3-254, neither may contain a control
// character or `<`/`>` (those are what wrap an address in a commit's own
// "Name <email>" line, so letting them through would corrupt it), and
// neither may start with `-` (git would read it as a flag). `hasControlChars`
// mirrors the backend's own `hasControlChars` (backend/src/lib/text.ts)
// exactly, including the C1 range (0x80-0x9F) — the same charCodeAt-loop
// idiom `features/env-files/lib/path-rules.ts`'s identical helper uses,
// since biome's noControlCharactersInRegex rule refuses a
// `/[\u0000-\u001f]/`-shaped regex outright.
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    // C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F).
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

const noAngleBrackets = (value: string) => !value.includes('<') && !value.includes('>')
const notDashPrefixed = (value: string) => !value.startsWith('-')

const nameSchema = z
  .string()
  .trim()
  .min(1, { message: 'projects.gitIdentity.errors.nameRequired' })
  .max(200, { message: 'projects.gitIdentity.errors.nameTooLong' })
  .refine((v) => !hasControlChars(v), { message: 'projects.gitIdentity.errors.nameInvalid' })
  .refine(noAngleBrackets, { message: 'projects.gitIdentity.errors.nameInvalid' })
  .refine(notDashPrefixed, { message: 'projects.gitIdentity.errors.nameInvalid' })

// Intentionally looser than a full RFC 5322 address — it only has to look
// like `local@domain` with no whitespace, angle brackets, or a second `@`
// (the same shape the backend's own regex checks), so a GitHub noreply
// address like `123+user@users.noreply.github.com` still passes.
const EMAIL_SHAPE = /^[^\s<>@]+@[^\s<>@]+$/

const emailSchema = z
  .string()
  .trim()
  .min(3, { message: 'projects.gitIdentity.errors.emailRequired' })
  .max(254, { message: 'projects.gitIdentity.errors.emailTooLong' })
  .refine((v) => !hasControlChars(v), { message: 'projects.gitIdentity.errors.emailInvalid' })
  .refine(notDashPrefixed, { message: 'projects.gitIdentity.errors.emailInvalid' })
  .refine((v) => EMAIL_SHAPE.test(v), { message: 'projects.gitIdentity.errors.emailInvalid' })

export const gitIdentityFormSchema = z.object({
  name: nameSchema,
  email: emailSchema,
})

export type GitIdentityFormValues = z.infer<typeof gitIdentityFormSchema>
