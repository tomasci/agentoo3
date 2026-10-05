import type { ReactNode } from 'react'
import { useId } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/shared/ui/field'

/**
 * The bits every shadcn form control needs wired up to this field's label and
 * message — Base UI's `Field` is unstyled markup only, with no context a
 * plain `Input`/`Textarea`/`Select` trigger reads from, so the caller passes
 * these onto the control by hand instead. Mirrors `features/ideas/components/
 * form-field.tsx` (same reasoning, same shape); duplicated rather than
 * imported across the feature boundary, the same choice this app's small
 * `lib/format.ts` copies make throughout (see `features/library/lib/
 * format.ts`'s own comment on why).
 */
export interface FormFieldControlProps {
  id: string
  'aria-invalid': boolean
  'aria-describedby': string | undefined
}

interface FormFieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: (control: FormFieldControlProps) => ReactNode
}

/** One field: a label, the control, and a hint or an error underneath it —
 *  never both at once. Every automation form (`automation-form-dialog.tsx`,
 *  its `schedule-fields.tsx`) shares this rather than each hand-wiring the
 *  same three ids. */
export function FormField({ label, hint, error, children }: FormFieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  const invalid = error != null

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({
        id,
        'aria-invalid': invalid,
        'aria-describedby': invalid || hint != null ? messageId : undefined,
      })}
      {invalid ? (
        <FieldError id={messageId}>{error}</FieldError>
      ) : (
        hint != null && <FieldDescription id={messageId}>{hint}</FieldDescription>
      )}
    </Field>
  )
}
