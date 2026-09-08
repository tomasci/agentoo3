import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Inline,
  PageHeader,
  Spinner,
  Stack,
  Textarea,
} from '@/shared/ui'
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

  if (isPending) return <Spinner label={t('common.loading')} block />

  return (
    <Stack gap={5}>
      <PageHeader
        title={t('prompts.title')}
        description={t('prompts.description')}
        actions={
          prompt && (
            <Badge tone={isDefault ? 'neutral' : 'accent'}>
              {isDefault ? t('prompts.sourceDefault') : t('prompts.sourceFile')}
            </Badge>
          )
        }
      />

      {loadError && (
        <Alert tone="danger">{apiErrorMessage(loadError, t('prompts.loadFailed'))}</Alert>
      )}

      {prompt && (
        <Stack gap={5}>
          {isDefault && <Alert tone="neutral">{t('prompts.defaultNotice')}</Alert>}

          <Field label={t('prompts.body')} hint={t('prompts.bodyHint')}>
            <Textarea
              mono
              rows={20}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          </Field>

          {error && <Alert tone="danger">{error}</Alert>}

          <Inline gap={2}>
            <Button type="button" disabled={busy || !draft.trim()} onClick={save}>
              {busy ? t('common.working') : t('common.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={isDefault || reset.isPending}
              onClick={() => setConfirmReset(true)}
            >
              {t('prompts.resetToDefault')}
            </Button>
          </Inline>
        </Stack>
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
    </Stack>
  )
}
