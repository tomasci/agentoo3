import { CircleAlertIcon, InfoIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ConfirmDialog, Loading, PageHeader, StatusBadge } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Textarea } from '@/shared/ui/textarea'
import { usePrompt, useResetPrompt, useUpdatePrompt } from '../hooks/use-prompts'

/**
 * A fixed-name, operator-editable instruction — a document, not a setting, so
 * this follows the library editors' layout (see skill-editor-page.tsx) rather
 * than SettingsPage's form-of-preferences one. Unlike a library item, `name`
 * is not something this page lets you pick or rename: it identifies one of
 * the backend's small, fixed registry of known prompts (KNOWN_PROMPTS in
 * features/system/prompts.ts), addressed from the route rather than editable
 * here.
 */
export function PromptEditorPage({ name }: { name: string }) {
  const { t } = useTranslation()
  const { data: prompt, isPending, error: loadError } = usePrompt(name)
  const update = useUpdatePrompt(name)
  const reset = useResetPrompt(name)

  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (prompt) setDraft(prompt.body)
  }, [prompt])

  const save = () => {
    setError(null)
    update.mutate(
      { path: { name }, body: { body: draft } },
      { onError: (e) => setError(apiErrorMessage(e, t('prompts.saveFailed'))) },
    )
  }

  const busy = update.isPending
  const isDefault = prompt?.source === 'default'

  if (isPending) return <Loading label={t('common.loading')} block />

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('prompts.title')}
        description={t('prompts.description')}
        actions={
          prompt && (
            <StatusBadge tone={isDefault ? 'neutral' : 'accent'}>
              {isDefault ? t('prompts.sourceDefault') : t('prompts.sourceFile')}
            </StatusBadge>
          )
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{apiErrorMessage(loadError, t('prompts.loadFailed'))}</AlertDescription>
        </Alert>
      )}

      {prompt && (
        <div className="flex flex-col gap-5">
          {isDefault && (
            <Alert role="status">
              <InfoIcon />
              <AlertDescription>{t('prompts.defaultNotice')}</AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="prompt-body">{t('prompts.body')}</FieldLabel>
            <Textarea
              id="prompt-body"
              className="field-sizing-fixed font-mono"
              rows={20}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            <FieldDescription>{t('prompts.bodyHint')}</FieldDescription>
          </Field>

          {error && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy || !draft.trim()} onClick={save}>
              {busy ? t('common.working') : t('common.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isDefault || reset.isPending}
              onClick={() => setConfirmReset(true)}
            >
              {t('prompts.resetToDefault')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('prompts.resetTitle')}
        description={t('prompts.resetConfirm')}
        confirmLabel={t('prompts.resetToDefault')}
        busy={reset.isPending}
        onConfirm={() =>
          reset.mutate(
            { path: { name } },
            {
              onSuccess: () => setConfirmReset(false),
              onError: (e) => {
                setConfirmReset(false)
                setError(apiErrorMessage(e, t('prompts.resetFailed')))
              },
            },
          )
        }
      />
    </div>
  )
}
