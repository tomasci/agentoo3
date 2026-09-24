import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import { Code, CopyButton } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group'
import { useCreateProject } from '../hooks/use-projects'
import { useSources } from '../hooks/use-sources'
import { apiErrorMessage } from '../lib/api-error'
import { type ProjectFormValues, projectFormSchema } from '../model/project-form.schema'
import { FormField } from './form-field'

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
    control,
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

  // Zod's messages are translation keys, not display text.
  const fieldError = (message?: string) => (message ? t(message) : undefined)

  // '' is a real, always-present choice here ("use ssh defaults"), not an
  // unselected state, so it is a genuine item in the list rather than a
  // placeholder.
  const sshKeyOptions = [
    { value: '', label: t('projects.form.sshKeyNone') },
    ...(sshKeys ?? []).map((key) => ({
      value: key.id,
      label: key.comment ? `${key.name} — ${key.comment}` : key.name,
    })),
  ]

  // Disabled options for already-adopted folders — the reason this is a
  // `Select`, not a native `<select>`, which can't style a disabled option or
  // give it a second line of explanation.
  const folderOptions = entries.map((entry) => ({
    value: entry.name,
    label: entry.isGitRepo ? `${entry.name} · git` : entry.name,
    description: entry.adopted
      ? t('projects.form.folderTaken', { name: entry.adoptedBy })
      : undefined,
    disabled: entry.adopted,
  }))
  const folderPlaceholder = sourcesPending
    ? t('common.loading')
    : available.length === 0
      ? t('projects.form.folderNone')
      : t('projects.form.folderChoose')

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
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.form.heading')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-3">
          <ToggleGroup
            aria-label={t('projects.form.sourceLabel')}
            variant="outline"
            value={[source]}
            onValueChange={(values) => {
              // Base UI's toggle group reports a pressed set, not a single
              // value; deselecting the only pressed item in this single-select
              // group would report `[]`, which has to be ignored rather than
              // clearing the field — there is always exactly one source.
              const next = values[0]
              if (next) setValue('source', next as ProjectFormValues['source'])
            }}
          >
            {SOURCES.map((option) => (
              <ToggleGroupItem key={option} value={option}>
                {t(`projects.form.source_${option}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <FormField label={t('projects.form.name')} error={fieldError(errors.name?.message)}>
            {(field) => (
              <Input
                placeholder={t('projects.form.namePlaceholder')}
                {...register('name')}
                {...field}
              />
            )}
          </FormField>

          {source === 'clone' && (
            <>
              <FormField
                label={t('projects.form.remote')}
                hint={t('projects.form.remoteHint')}
                error={fieldError(errors.remoteUrl?.message)}
              >
                {(field) => (
                  <Input
                    placeholder="https://github.com/user/repo.git"
                    {...register('remoteUrl')}
                    {...field}
                  />
                )}
              </FormField>

              <FormField
                label={t('projects.form.sshKey')}
                hint={
                  (sshKeys ?? []).length === 0
                    ? t('projects.form.sshKeyEmptyHint')
                    : t('projects.form.sshKeyHint')
                }
              >
                {(field) => (
                  <Controller
                    control={control}
                    name="sshKeyId"
                    render={({ field: rhf }) => (
                      <Select
                        items={sshKeyOptions}
                        value={rhf.value}
                        onValueChange={(value) => rhf.onChange(value ?? '')}
                        name={rhf.name}
                      >
                        <SelectTrigger className="w-full" {...field} ref={rhf.ref}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {sshKeyOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </FormField>
            </>
          )}

          {source === 'existing' && (
            <div className="flex flex-col gap-2">
              <FormField
                label={t('projects.form.folder')}
                error={fieldError(errors.sourceName?.message)}
              >
                {/* A list, not a path field: adoption is restricted to this
                    one directory, so there is nothing sensible to type. */}
                {(field) => (
                  <Controller
                    control={control}
                    name="sourceName"
                    render={({ field: rhf }) => (
                      <Select
                        items={folderOptions}
                        value={rhf.value || null}
                        onValueChange={(value) => rhf.onChange(value ?? '')}
                        name={rhf.name}
                      >
                        <SelectTrigger className="w-full" {...field} ref={rhf.ref}>
                          <SelectValue placeholder={folderPlaceholder} />
                        </SelectTrigger>
                        <SelectContent>
                          {folderOptions.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              disabled={option.disabled}
                            >
                              <span className="flex min-w-0 flex-col">
                                <span>{option.label}</span>
                                {option.description && (
                                  <span className="text-xs text-muted-foreground">
                                    {option.description}
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </FormField>

              <div className="rounded-md border p-2">
                <p className="mb-2 text-xs text-muted-foreground">{t('projects.form.folderTip')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Code>{sources?.dir ?? '…'}</Code>
                  {sources?.dir && <CopyButton value={sources.dir} />}
                </div>
              </div>
            </div>
          )}

          {source === 'empty' && (
            <p className="text-xs text-muted-foreground">{t('projects.form.emptyHint')}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={create.isPending || (source === 'existing' && available.length === 0)}
            >
              {create.isPending ? t('projects.form.adding') : t('projects.form.submit')}
            </Button>
          </div>

          {serverError && (
            <Alert variant="destructive">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
