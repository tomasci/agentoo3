import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Inline,
  Input,
  PageHeader,
  Spinner,
  Stack,
} from '@/shared/ui'
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

  // Zod's messages are translation keys, not display text; `Field` derives
  // `invalid` from `error != null`, so this keeps the two in step without a
  // separate `invalid={Boolean(...)}` expression to drift out of sync by hand.
  const fieldError = (message?: string) => (message ? t(message) : undefined)

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
    <Stack gap={8}>
      <PageHeader title={t('sshKeys.heading')} description={t('sshKeys.intro')} />

      <Card variant="dashed">
        <Stack gap={3}>
          <h2 className={styles.heading}>{t('sshKeys.form.heading')}</h2>

          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <Stack gap={3}>
              <Field
                label={t('sshKeys.form.name')}
                hint={t('sshKeys.form.nameHint')}
                error={fieldError(errors.name?.message)}
              >
                <Input placeholder="github" {...register('name')} />
              </Field>

              <Field label={t('sshKeys.form.comment')} hint={t('sshKeys.form.commentHint')}>
                <Input placeholder="you@example.com" {...register('comment')} />
              </Field>

              <Inline gap={3}>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? t('sshKeys.form.generating') : t('sshKeys.form.submit')}
                </Button>
              </Inline>

              {serverError && <Alert>{serverError}</Alert>}
            </Stack>
          </form>

          <ol className={styles.steps}>
            <li>{t('sshKeys.steps.generate')}</li>
            <li>{t('sshKeys.steps.copy')}</li>
            <li>{t('sshKeys.steps.test')}</li>
            <li>{t('sshKeys.steps.use')}</li>
          </ol>
        </Stack>
      </Card>

      {isError && <Alert>{apiErrorMessage(error, t('sshKeys.loadFailed'))}</Alert>}
      {isPending && <Spinner label={t('common.loading')} block />}
      {!isPending && !isError && keys.length === 0 && <EmptyState title={t('sshKeys.empty')} />}
      {keys.length > 0 && (
        <div className={styles.list}>
          {keys.map((k) => (
            <SshKeyCard key={k.id} sshKey={k} />
          ))}
        </div>
      )}
    </Stack>
  )
}
