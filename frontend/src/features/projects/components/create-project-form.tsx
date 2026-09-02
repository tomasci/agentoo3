import { Field } from '@ark-ui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Button, CopyButton } from '@/shared/ui'
import { useCreateProject } from '../hooks/use-projects'
import { useSources } from '../hooks/use-sources'
import { apiErrorMessage } from '../lib/api-error'
import { type ProjectFormValues, projectFormSchema } from '../model/project-form.schema'
import styles from './create-project-form.module.scss'

const SOURCES = ['clone', 'existing', 'empty'] as const

/**
 * `onCreated` lets the caller take the new project somewhere — the picker in an
 * empty tab settles that project into the tab instead of leaving the reader on
 * a form they have already finished with.
 */
export function CreateProjectForm({ onCreated }: { onCreated?: (projectId: string) => void }) {
  const { t } = useTranslation()
  const create = useCreateProject()
  const { data: sshKeys } = useSshKeys()
  const { data: sources, isPending: sourcesPending } = useSources()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: { name: '', source: 'clone', remoteUrl: '', sourceName: '', sshKeyId: '' },
  })

  const source = watch('source')
  const entries = sources?.entries ?? []
  const available = entries.filter((e) => !e.adopted)

  const onSubmit = (values: ProjectFormValues) => {
    setServerError(null)
    const body =
      values.source === 'clone'
        ? {
            name: values.name,
            remoteUrl: values.remoteUrl,
            // Empty string means "ssh defaults", not a key.
            ...(values.sshKeyId ? { sshKeyId: values.sshKeyId } : {}),
          }
        : values.source === 'existing'
          ? { name: values.name, sourceName: values.sourceName }
          : { name: values.name, empty: true }

    create.mutate(
      { body },
      {
        onSuccess: (project) => {
          reset()
          onCreated?.(project.id)
        },
        // The backend's message is the useful one — it names the exact rule the
        // input broke rather than just the status code.
        onError: (error) => setServerError(apiErrorMessage(error, t('projects.form.failed'))),
      },
    )
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.heading}>{t('projects.form.heading')}</h2>

      <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
        <fieldset className={styles.tabs}>
          <legend className={styles.srOnly}>{t('projects.form.sourceLabel')}</legend>
          {SOURCES.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.tab}
              aria-pressed={source === option}
              onClick={() => setValue('source', option)}
            >
              {t(`projects.form.source_${option}`)}
            </button>
          ))}
        </fieldset>

        <Field.Root invalid={Boolean(errors.name)}>
          <Field.Label className={styles.label}>{t('projects.form.name')}</Field.Label>
          <Field.Input
            className={styles.input}
            placeholder={t('projects.form.namePlaceholder')}
            {...register('name')}
          />
          {errors.name?.message && (
            <Field.ErrorText className={styles.error}>{t(errors.name.message)}</Field.ErrorText>
          )}
        </Field.Root>

        {source === 'clone' && (
          <>
            <Field.Root invalid={Boolean(errors.remoteUrl)}>
              <Field.Label className={styles.label}>{t('projects.form.remote')}</Field.Label>
              <Field.Input
                className={styles.input}
                placeholder="https://github.com/user/repo.git"
                {...register('remoteUrl')}
              />
              <span className={styles.hint}>{t('projects.form.remoteHint')}</span>
              {errors.remoteUrl?.message && (
                <Field.ErrorText className={styles.error}>
                  {t(errors.remoteUrl.message)}
                </Field.ErrorText>
              )}
            </Field.Root>

            <Field.Root>
              <Field.Label className={styles.label}>{t('projects.form.sshKey')}</Field.Label>
              <select className={styles.input} {...register('sshKeyId')}>
                <option value="">{t('projects.form.sshKeyNone')}</option>
                {(sshKeys ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                    {k.comment ? ` — ${k.comment}` : ''}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                {(sshKeys ?? []).length === 0
                  ? t('projects.form.sshKeyEmptyHint')
                  : t('projects.form.sshKeyHint')}
              </span>
            </Field.Root>
          </>
        )}

        {source === 'existing' && (
          <Field.Root invalid={Boolean(errors.sourceName)}>
            <Field.Label className={styles.label}>{t('projects.form.folder')}</Field.Label>

            {/* A list, not a path field: adoption is restricted to this one
                directory, so there is nothing sensible to type. */}
            <select className={styles.input} {...register('sourceName')}>
              <option value="">
                {sourcesPending
                  ? t('common.loading')
                  : available.length === 0
                    ? t('projects.form.folderNone')
                    : t('projects.form.folderChoose')}
              </option>
              {entries.map((entry) => (
                <option key={entry.name} value={entry.name} disabled={entry.adopted}>
                  {entry.name}
                  {entry.isGitRepo ? ' · git' : ''}
                  {entry.adopted
                    ? ` — ${t('projects.form.folderTaken', { name: entry.adoptedBy })}`
                    : ''}
                </option>
              ))}
            </select>

            {errors.sourceName?.message && (
              <Field.ErrorText className={styles.error}>
                {t(errors.sourceName.message)}
              </Field.ErrorText>
            )}

            <div className={styles.tip}>
              <p className={styles.tipText}>{t('projects.form.folderTip')}</p>
              <div className={styles.tipRow}>
                <code className={styles.tipPath}>{sources?.dir ?? '…'}</code>
                {sources?.dir && <CopyButton value={sources.dir} />}
              </div>
            </div>
          </Field.Root>
        )}

        {source === 'empty' && <p className={styles.hint}>{t('projects.form.emptyHint')}</p>}

        <div className={styles.submitRow}>
          <Button
            type="submit"
            disabled={create.isPending || (source === 'existing' && available.length === 0)}
          >
            {create.isPending ? t('projects.form.adding') : t('projects.form.submit')}
          </Button>
          {serverError && <span className={styles.error}>{serverError}</span>}
        </div>
      </form>
    </section>
  )
}
