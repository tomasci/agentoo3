import { Field } from '@ark-ui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui'
import { useCreateProject } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { type ProjectFormValues, projectFormSchema } from '../model/project-form.schema'
import styles from './create-project-form.module.scss'

export function CreateProjectForm() {
  const { t } = useTranslation()
  const create = useCreateProject()
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
    defaultValues: { name: '', source: 'clone', remoteUrl: '', existingPath: '' },
  })

  const source = watch('source')

  const onSubmit = (values: ProjectFormValues) => {
    setServerError(null)
    create.mutate(
      {
        body:
          values.source === 'clone'
            ? { name: values.name, remoteUrl: values.remoteUrl }
            : { name: values.name, existingPath: values.existingPath },
      },
      {
        onSuccess: () => reset(),
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
          <button
            type="button"
            className={styles.tab}
            aria-pressed={source === 'clone'}
            onClick={() => setValue('source', 'clone')}
          >
            {t('projects.form.sourceClone')}
          </button>
          <button
            type="button"
            className={styles.tab}
            aria-pressed={source === 'existing'}
            onClick={() => setValue('source', 'existing')}
          >
            {t('projects.form.sourceExisting')}
          </button>
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

        {source === 'clone' ? (
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
        ) : (
          <Field.Root invalid={Boolean(errors.existingPath)}>
            <Field.Label className={styles.label}>{t('projects.form.path')}</Field.Label>
            <Field.Input
              className={styles.input}
              placeholder="/srv/my-app"
              {...register('existingPath')}
            />
            <span className={styles.hint}>{t('projects.form.pathHint')}</span>
            {errors.existingPath?.message && (
              <Field.ErrorText className={styles.error}>
                {t(errors.existingPath.message)}
              </Field.ErrorText>
            )}
          </Field.Root>
        )}

        <div className={styles.submitRow}>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('projects.form.adding') : t('projects.form.submit')}
          </Button>
          {serverError && <span className={styles.error}>{serverError}</span>}
        </div>
      </form>
    </section>
  )
}
