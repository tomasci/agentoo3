import { Field } from '@ark-ui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
import { useCreateSshKey, useSshKeys } from '../hooks/use-ssh-keys'
import { type SshKeyFormValues, sshKeyFormSchema } from '../model/ssh-key-form.schema'
import { SshKeyCard } from './ssh-key-card'
import styles from './ssh-keys-page.module.scss'

export function SshKeysPage() {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useSshKeys()
  const create = useCreateSshKey()
  const [serverError, setServerError] = useState<string | null>(null)
  const keys = data ?? []

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SshKeyFormValues>({
    resolver: zodResolver(sshKeyFormSchema),
    defaultValues: { name: '', comment: '' },
  })

  const onSubmit = (values: SshKeyFormValues) => {
    setServerError(null)
    create.mutate(
      { body: { name: values.name, comment: values.comment || undefined } },
      {
        onSuccess: () => reset(),
        onError: (e) => setServerError(apiErrorMessage(e, t('sshKeys.form.failed'))),
      },
    )
  }

  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('sshKeys.intro')}</p>

      <section className={styles.formCard}>
        <h2 className={styles.heading}>{t('sshKeys.form.heading')}</h2>
        <form className={styles.form} onSubmit={handleSubmit(onSubmit)} noValidate>
          <Field.Root invalid={Boolean(errors.name)}>
            <Field.Label className={styles.label}>{t('sshKeys.form.name')}</Field.Label>
            <Field.Input className={styles.input} placeholder="github" {...register('name')} />
            <span className={styles.hint}>{t('sshKeys.form.nameHint')}</span>
            {errors.name?.message && (
              <Field.ErrorText className={styles.error}>{t(errors.name.message)}</Field.ErrorText>
            )}
          </Field.Root>

          <Field.Root>
            <Field.Label className={styles.label}>{t('sshKeys.form.comment')}</Field.Label>
            <Field.Input
              className={styles.input}
              placeholder="you@example.com"
              {...register('comment')}
            />
            <span className={styles.hint}>{t('sshKeys.form.commentHint')}</span>
          </Field.Root>

          <div className={styles.actions}>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t('sshKeys.form.generating') : t('sshKeys.form.submit')}
            </Button>
            {serverError && <span className={styles.error}>{serverError}</span>}
          </div>
        </form>

        <ol className={styles.steps}>
          <li>{t('sshKeys.steps.generate')}</li>
          <li>{t('sshKeys.steps.copy')}</li>
          <li>{t('sshKeys.steps.test')}</li>
          <li>{t('sshKeys.steps.use')}</li>
        </ol>
      </section>

      <div>
        <h2 className={styles.heading}>{t('sshKeys.heading')}</h2>
        {isError && (
          <p className={styles.error}>{apiErrorMessage(error, t('sshKeys.loadFailed'))}</p>
        )}
        {isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!isPending && !isError && keys.length === 0 && (
          <p className={styles.empty}>{t('sshKeys.empty')}</p>
        )}
        {keys.length > 0 && (
          <div className={styles.list}>
            {keys.map((k) => (
              <SshKeyCard key={k.id} sshKey={k} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
