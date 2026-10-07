import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Code, Loading, toast } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'
import { useDeleteGitIdentity, useGitIdentity, usePutGitIdentity } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import {
  type GitIdentityFormValues,
  gitIdentityFormSchema,
} from '../model/git-identity-form.schema'

const FIELD_ID = 'project-git-identity'

/**
 * The name/email agents commit as in this project — stored only in this
 * repo's own `.git/config` (see the backend's `GitIdentityState` doc comment),
 * shared by every session's worktree, so it gets its own card rather than a
 * field on `project-overview.tsx`'s Details list. Follows the same
 * query/loading/error-owning, save-then-reseed pattern as `SessionLimitCard`/
 * `LearningScheduleCard` in the settings feature, with a Clear action (DELETE)
 * in place of their "reset to default" — there is no server default here to
 * fall back to, only "nothing set", which DELETE both produces and is
 * idempotent about.
 */
export function GitIdentityCard({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data, isPending, isError, error: loadError } = useGitIdentity(projectId)
  const put = usePutGitIdentity(projectId)
  const del = useDeleteGitIdentity(projectId)
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isDirty, isValid },
  } = useForm<GitIdentityFormValues>({
    resolver: zodResolver(gitIdentityFormSchema),
    mode: 'onChange',
    // Never actually shown — the form only renders once `data` has loaded
    // (below), the same reasoning SessionLimitCard's identical comment gives
    // for its own `defaultValues`.
    defaultValues: { name: data?.local.name ?? '', email: data?.local.email ?? '' },
  })

  // Re-seeds on first load and whenever the local identity changes from
  // elsewhere (a save or clear from a second tab) — the same `serverValue`
  // effect SessionLimitCard uses, scoped to the two fields that can change.
  const localName = data?.local.name
  const localEmail = data?.local.email
  useEffect(() => {
    if (!data) return
    reset({ name: localName ?? '', email: localEmail ?? '' })
  }, [data, localName, localEmail, reset])

  const save = (values: GitIdentityFormValues) => {
    setServerError(null)
    put.mutate(
      { path: { id: projectId }, body: values },
      {
        onSuccess: (next) => {
          reset({ name: next.local.name ?? '', email: next.local.email ?? '' })
          toast.add({ title: t('projects.gitIdentity.saved'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('projects.gitIdentity.saveFailed'))),
      },
    )
  }

  const clear = () => {
    setServerError(null)
    del.mutate(
      { path: { id: projectId } },
      {
        onSuccess: (next) => {
          reset({ name: next.local.name ?? '', email: next.local.email ?? '' })
          toast.add({ title: t('projects.gitIdentity.cleared'), type: 'success' })
        },
        onError: (e) => setServerError(apiErrorMessage(e, t('projects.gitIdentity.clearFailed'))),
      },
    )
  }

  const nameError = errors.name?.message
  const emailError = errors.email?.message
  const busy = put.isPending || del.isPending
  const hasLocal = Boolean(data?.local.name || data?.local.email)
  const localComplete = Boolean(data?.local.name && data?.local.email)
  const effectiveComplete = Boolean(data?.effective.name && data?.effective.email)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.gitIdentity.heading')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">{t('projects.gitIdentity.explain')}</p>

        {isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(loadError, t('projects.gitIdentity.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {isPending && <Loading label={t('common.loading')} />}

        {!isPending && !isError && data && !data.available && (
          <p className="text-xs text-muted-foreground">{t('projects.gitIdentity.unavailable')}</p>
        )}

        {!isPending && !isError && data?.available && (
          <>
            {data.configPath && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t('projects.gitIdentity.configPathLead')}</span>
                <Code wrap>{data.configPath}</Code>
              </p>
            )}

            {/* `hasLocal` here means exactly one of the two fields is set
                locally (both-set is `localComplete`, already handled above):
                the server-wide identity is still what's effective, but part
                of it is this project's own, so that's called out distinctly
                from the fully-unset case rather than folded into it. */}
            {localComplete ? (
              <FieldDescription>
                {t('projects.gitIdentity.statusSet', {
                  name: data.local.name,
                  email: data.local.email,
                })}
              </FieldDescription>
            ) : effectiveComplete ? (
              <FieldDescription>
                {t(
                  hasLocal
                    ? 'projects.gitIdentity.statusPartial'
                    : 'projects.gitIdentity.statusEffective',
                  { name: data.effective.name, email: data.effective.email },
                )}
              </FieldDescription>
            ) : (
              <Alert variant="destructive">
                <AlertDescription>{t('projects.gitIdentity.statusMissing')}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-4">
              <FieldGroup>
                <Field data-invalid={nameError ? true : undefined}>
                  <FieldLabel htmlFor={`${FIELD_ID}-name`}>
                    {t('projects.gitIdentity.name')}
                  </FieldLabel>
                  <Controller
                    control={control}
                    name="name"
                    render={({ field }) => (
                      <Input
                        id={`${FIELD_ID}-name`}
                        aria-invalid={Boolean(nameError)}
                        value={field.value}
                        onChange={field.onChange}
                        name={field.name}
                        ref={field.ref}
                      />
                    )}
                  />
                  {nameError && <FieldError>{t(nameError)}</FieldError>}
                </Field>

                <Field data-invalid={emailError ? true : undefined}>
                  <FieldLabel htmlFor={`${FIELD_ID}-email`}>
                    {t('projects.gitIdentity.email')}
                  </FieldLabel>
                  <Controller
                    control={control}
                    name="email"
                    render={({ field }) => (
                      <Input
                        id={`${FIELD_ID}-email`}
                        type="email"
                        aria-invalid={Boolean(emailError)}
                        value={field.value}
                        onChange={field.onChange}
                        name={field.name}
                        ref={field.ref}
                      />
                    )}
                  />
                  {emailError && <FieldError>{t(emailError)}</FieldError>}
                </Field>
              </FieldGroup>

              {serverError && (
                <Alert variant="destructive">
                  <AlertDescription>{serverError}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={busy || !isDirty || !isValid}>
                  {put.isPending && <Spinner data-icon="inline-start" />}
                  {t('common.save')}
                </Button>
                {hasLocal && (
                  <Button type="button" variant="outline" disabled={busy} onClick={clear}>
                    {del.isPending && <Spinner data-icon="inline-start" />}
                    {t('projects.gitIdentity.clear')}
                  </Button>
                )}
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  )
}
