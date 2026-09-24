import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, CircleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Code, ConfirmDialog, Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { useCreateSkill, useDeleteSkill, useSkill, useUpdateSkill } from '../hooks/use-library'

export function SkillEditorPage({ name }: { name?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isNew = !name
  const { data: skill, isPending } = useSkill(name ?? '')
  const create = useCreateSkill()
  const update = useUpdateSkill()
  const remove = useDeleteSkill()

  const [draft, setDraft] = useState({ name: '', description: '', body: '' })
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (skill) setDraft({ name: skill.name, description: skill.description, body: skill.body })
  }, [skill])

  const save = () => {
    setError(null)
    const onError = (e: unknown) => setError(apiErrorMessage(e, t('library.saveFailed')))
    const body = { description: draft.description, body: draft.body }
    if (isNew) {
      create.mutate(
        { body: { name: draft.name, ...body } },
        { onSuccess: () => void navigate({ to: '/library' }), onError },
      )
    } else {
      update.mutate(
        { path: { name }, body },
        { onSuccess: () => void navigate({ to: '/library' }), onError },
      )
    }
  }

  const busy = create.isPending || update.isPending
  if (!isNew && isPending) return <Loading label={t('common.loading')} block />

  return (
    <div className="flex flex-col gap-5">
      <Link
        to="/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('library.backToLibrary')}
      </Link>

      <PageHeader title={isNew ? t('library.newSkill') : draft.name || name} />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
            <Field>
              <FieldLabel htmlFor="skill-name">{t('library.skill.name')}</FieldLabel>
              <Input
                id="skill-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="testing"
              />
              <FieldDescription>
                {isNew ? t('library.skill.nameHint') : t('library.skill.renameHint')}
              </FieldDescription>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="skill-description">{t('library.skill.description')}</FieldLabel>
            <Input
              id="skill-description"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={t('library.skill.descriptionPlaceholder')}
            />
            <FieldDescription>{t('library.skill.descriptionHint')}</FieldDescription>
          </Field>

          {skill && skill.extraFiles.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('library.skill.bundled')}</span>
              <Code block wrap>
                {skill.extraFiles.join('\n')}
              </Code>
            </div>
          )}
        </CardContent>
      </Card>

      <Field>
        <FieldLabel htmlFor="skill-body">{t('library.skill.body')}</FieldLabel>
        <Textarea
          id="skill-body"
          className="field-sizing-fixed font-mono"
          rows={20}
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          spellCheck={false}
        />
        <FieldDescription>{t('library.skill.bodyHint')}</FieldDescription>
      </Field>

      <div className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={busy || !draft.name || !draft.description || !draft.body}
            onClick={save}
          >
            {busy ? t('common.working') : t('common.save')}
          </Button>
          {!isNew && (
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
              {t('common.delete')}
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('library.skill.deleteTitle')}
        description={
          // The directory is the skill, so bundled files go with it. Name them
          // rather than deleting someone's scripts silently.
          skill && skill.extraFiles.length > 0
            ? t('library.skill.deleteConfirmWithFiles', {
                name,
                files: skill.extraFiles.join(', '),
              })
            : t('library.skill.deleteConfirm', { name })
        }
        busy={remove.isPending}
        onConfirm={() =>
          name &&
          remove.mutate({ path: { name } }, { onSuccess: () => void navigate({ to: '/library' }) })
        }
      />
    </div>
  )
}
