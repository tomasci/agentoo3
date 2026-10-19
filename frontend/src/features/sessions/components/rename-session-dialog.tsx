import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Field, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { useUpdateSession } from '../hooks/use-sessions'
import { MAX_TITLE_LENGTH } from '../lib/title'

const RENAME_SESSION_FORM_ID = 'rename-session-form'

/**
 * Renames one session from a list row. The session page's own title renames
 * inline instead (`SessionTitle`); a row has no title of its own to turn into
 * an input, hence a dialog.
 *
 * Rendered once by its caller and kept mounted across opens, so the value and
 * the error are reset when `open` turns true rather than on mount. `session`
 * is `null` while nothing is being renamed.
 */
export function RenameSessionDialog({
  session,
  open,
  onOpenChange,
}: {
  session: { id: string; title: string | null } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const update = useUpdateSession()
  const inputId = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Bumped on every open, so a request still in flight from an attempt the
  // reader already cancelled cannot close — or put its error into — the
  // dialog they have since opened for a different session.
  const openingRef = useRef(0)

  // The raw title, not the displayed one: an untitled session starts empty
  // with the fallback only as a placeholder, so Save cannot "rename" it to the
  // fallback text by accident.
  const currentTitle = session?.title ?? ''

  useEffect(() => {
    if (!open) return
    openingRef.current++
    setValue(currentTitle)
    setError(null)
  }, [open, currentTitle])

  const trimmed = value.trim()
  const canSave = !update.isPending && trimmed !== '' && trimmed !== currentTitle

  const submit = () => {
    if (!session || !canSave) return
    setError(null)
    const opening = openingRef.current
    update.mutate(
      { path: { id: session.id }, body: { title: trimmed } },
      {
        onSuccess: () => {
          if (openingRef.current === opening) onOpenChange(false)
        },
        onError: (e) => {
          if (openingRef.current === opening)
            setError(apiErrorMessage(e, t('sessions.renameFailed')))
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sessions.renameTitle')}</DialogTitle>
        </DialogHeader>

        <form
          id={RENAME_SESSION_FORM_ID}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          <Field>
            <FieldLabel htmlFor={inputId}>{t('sessions.form.title')}</FieldLabel>
            <Input
              id={inputId}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={MAX_TITLE_LENGTH}
              placeholder={
                session ? t('sessions.untitled', { id: session.id.slice(0, 8) }) : undefined
              }
            />
          </Field>

          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('common.cancel')}
          </DialogClose>
          <Button type="submit" form={RENAME_SESSION_FORM_ID} disabled={!canSave}>
            {update.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
