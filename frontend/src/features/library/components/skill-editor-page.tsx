import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmDialog,
  Field,
  Inline,
  Input,
  PageHeader,
  Spinner,
  Stack,
  Textarea,
} from '@/shared/ui'
import { useCreateSkill, useDeleteSkill, useSkill, useUpdateSkill } from '../hooks/use-library'
import styles from './library.module.scss'

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
  if (!isNew && isPending) return <Spinner label={t('common.loading')} block />

  return (
    <Stack gap={5}>
      <Link to="/library" className={styles.back}>
        ← {t('library.backToLibrary')}
      </Link>

      <PageHeader title={isNew ? t('library.newSkill') : draft.name || name} />

      <Card>
        <Stack gap={3}>
          <div className={styles.grid}>
            <Field
              label={t('library.skill.name')}
              hint={isNew ? t('library.skill.nameHint') : t('library.skill.renameHint')}
            >
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="testing"
              />
            </Field>
          </div>

          <Field label={t('library.skill.description')} hint={t('library.skill.descriptionHint')}>
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={t('library.skill.descriptionPlaceholder')}
            />
          </Field>

          {skill && skill.extraFiles.length > 0 && (
            <Stack gap={1}>
              <span className={styles.hint}>{t('library.skill.bundled')}</span>
              <Code block wrap>
                {skill.extraFiles.join('\n')}
              </Code>
            </Stack>
          )}
        </Stack>
      </Card>

      <Field label={t('library.skill.body')} hint={t('library.skill.bodyHint')}>
        <Textarea
          mono
          rows={20}
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          spellCheck={false}
        />
      </Field>

      <Stack gap={3}>
        {error && <Alert>{error}</Alert>}
        <Inline gap={2}>
          <Button
            type="button"
            disabled={busy || !draft.name || !draft.description || !draft.body}
            onClick={save}
          >
            {busy ? t('common.working') : t('common.save')}
          </Button>
          {!isNew && (
            <Button type="button" onClick={() => setConfirmDelete(true)}>
              {t('common.delete')}
            </Button>
          )}
        </Inline>
      </Stack>

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
    </Stack>
  )
}
