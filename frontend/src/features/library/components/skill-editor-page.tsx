import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button, ConfirmDialog } from '@/shared/ui'
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
  if (!isNew && isPending) return <p>{t('common.loading')}</p>

  return (
    <div className={styles.editor}>
      <Link to="/library" className={styles.back}>
        ← {t('library.backToLibrary')}
      </Link>

      <section className={styles.card}>
        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="skill-name">
              {t('library.skill.name')}
            </label>
            <input
              id="skill-name"
              className={styles.input}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="testing"
            />
            <span className={styles.hint}>
              {isNew ? t('library.skill.nameHint') : t('library.skill.renameHint')}
            </span>
          </div>
        </div>

        <div className={styles.field} style={{ marginTop: '0.75rem' }}>
          <label className={styles.label} htmlFor="skill-desc">
            {t('library.skill.description')}
          </label>
          <input
            id="skill-desc"
            className={styles.input}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder={t('library.skill.descriptionPlaceholder')}
          />
          <span className={styles.hint}>{t('library.skill.descriptionHint')}</span>
        </div>

        {skill && skill.extraFiles.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <span className={styles.hint}>{t('library.skill.bundled')}</span>
            <ul className={styles.files}>
              {skill.extraFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={styles.field}>
        <label className={styles.label} htmlFor="skill-body">
          {t('library.skill.body')}
        </label>
        <textarea
          id="skill-body"
          className={styles.prompt}
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          spellCheck={false}
        />
        <span className={styles.hint}>{t('library.skill.bodyHint')}</span>
      </section>

      <div className={styles.controls}>
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
        {error && <span className={styles.error}>{error}</span>}
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
