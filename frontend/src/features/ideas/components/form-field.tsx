import type { ReactNode } from 'react'
import { useId } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/shared/ui/field'

/**
 * The bits every shadcn form control (`Input`/`Textarea`/a `Select` trigger)
 * needs wired up to this field's label and message. The old Ark `Field.Root`
 * did this for its children through `useFieldContext()`; Base UI's `Field` is
 * unstyled markup only — no context a plain `Input` reads from — so the
 * caller passes these onto the control by hand instead.
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

/**
 * One field: a label, the control, and a hint or an error underneath it —
 * never both at once, the same "an error replaces the hint" rule the old
 * `Field` wrapper used. Every idea form (`idea-board-page.tsx`'s create
 * dialog, `idea-settings-dialog.tsx`, `idea-canvas.tsx`'s block/group
 * dialogs) shares this rather than each hand-wiring the same three ids.
 */
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
