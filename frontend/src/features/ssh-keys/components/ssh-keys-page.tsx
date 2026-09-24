import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Input } from '@/shared/ui/input'
import { useCreateSshKey, useSshKeys } from '../hooks/use-ssh-keys'
import { type SshKeyFormValues, sshKeyFormSchema } from '../model/ssh-key-form.schema'
import { FormField } from './form-field'
import { SshKeyCard } from './ssh-key-card'

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

  // Zod's messages are translation keys, not display text.
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
    <div className="flex flex-col gap-8">
      <PageHeader title={t('sshKeys.heading')} description={t('sshKeys.intro')} />

      <Card>
        <CardHeader>
          <CardTitle>{t('sshKeys.form.heading')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-3">
            <FormField
              label={t('sshKeys.form.name')}
              hint={t('sshKeys.form.nameHint')}
              error={fieldError(errors.name?.message)}
            >
              {(field) => <Input placeholder="github" {...register('name')} {...field} />}
            </FormField>

            <FormField label={t('sshKeys.form.comment')} hint={t('sshKeys.form.commentHint')}>
              {(field) => (
                <Input placeholder="you@example.com" {...register('comment')} {...field} />
              )}
            </FormField>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t('sshKeys.form.generating') : t('sshKeys.form.submit')}
              </Button>
            </div>

            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}
          </form>

          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('sshKeys.steps.generate')}</li>
            <li>{t('sshKeys.steps.copy')}</li>
            <li>{t('sshKeys.steps.test')}</li>
            <li>{t('sshKeys.steps.use')}</li>
          </ol>
        </CardContent>
      </Card>

      {isError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(error, t('sshKeys.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {isPending && <Loading label={t('common.loading')} block />}
      {!isPending && !isError && keys.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('sshKeys.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {keys.length > 0 && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(30rem,100%),1fr))]">
          {keys.map((k) => (
            <SshKeyCard key={k.id} sshKey={k} />
          ))}
        </div>
      )}
    </div>
  )
}
