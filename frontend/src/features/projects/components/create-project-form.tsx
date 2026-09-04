import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import {
  Alert,
  Button,
  Card,
  Code,
  CopyButton,
  Field,
  Inline,
  Input,
  SegmentGroup,
  Select,
  Stack,
} from '@/shared/ui'
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

  // Zod's messages are translation keys, not display text; `Field` derives
  // `invalid` from `error != null`, so this keeps the two in step without a
  // separate `invalid={Boolean(...)}` expression to drift out of sync by hand.
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
    <Card variant="dashed">
      <Stack gap={3}>
        <h2 className={styles.heading}>{t('projects.form.heading')}</h2>

        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <Stack gap={3}>
            <SegmentGroup
              label={t('projects.form.sourceLabel')}
              options={SOURCES.map((option) => ({
                value: option,
                label: t(`projects.form.source_${option}`),
              }))}
              value={source}
              onValueChange={(value) => setValue('source', value as ProjectFormValues['source'])}
            />

            <Field label={t('projects.form.name')} error={fieldError(errors.name?.message)}>
              <Input placeholder={t('projects.form.namePlaceholder')} {...register('name')} />
            </Field>

            {source === 'clone' && (
              <>
                <Field
                  label={t('projects.form.remote')}
                  hint={t('projects.form.remoteHint')}
                  error={fieldError(errors.remoteUrl?.message)}
                >
                  <Input
                    placeholder="https://github.com/user/repo.git"
                    {...register('remoteUrl')}
                  />
                </Field>

                <Field
                  label={t('projects.form.sshKey')}
                  hint={
                    (sshKeys ?? []).length === 0
                      ? t('projects.form.sshKeyEmptyHint')
                      : t('projects.form.sshKeyHint')
                  }
                >
                  {/* Ark renders a hidden native `<select>` for its value, but
                      `register()`'s `onChange`/`onBlur` aren't props `Select`
                      accepts — it's a controlled value/onValueChange API, not
                      a native form control. `Controller` bridges the two. */}
                  <Controller
                    control={control}
                    name="sshKeyId"
                    render={({ field }) => (
                      <Select
                        options={sshKeyOptions}
                        value={field.value}
                        onValueChange={(value) => field.onChange(value ?? '')}
                        name={field.name}
                        ref={field.ref}
                      />
                    )}
                  />
                </Field>
              </>
            )}

            {source === 'existing' && (
              <Stack gap={2}>
                <Field
                  label={t('projects.form.folder')}
                  error={fieldError(errors.sourceName?.message)}
                >
                  {/* A list, not a path field: adoption is restricted to this
                      one directory, so there is nothing sensible to type. */}
                  <Controller
                    control={control}
                    name="sourceName"
                    render={({ field }) => (
                      <Select
                        options={folderOptions}
                        value={field.value || null}
                        onValueChange={(value) => field.onChange(value ?? '')}
                        placeholder={folderPlaceholder}
                        name={field.name}
                        ref={field.ref}
                      />
                    )}
                  />
                </Field>

                <div className={styles.tip}>
                  <p className={styles.tipText}>{t('projects.form.folderTip')}</p>
                  <Inline gap={2}>
                    <Code>{sources?.dir ?? '…'}</Code>
                    {sources?.dir && <CopyButton value={sources.dir} />}
                  </Inline>
                </div>
              </Stack>
            )}

            {source === 'empty' && <p className={styles.hint}>{t('projects.form.emptyHint')}</p>}

            <Inline gap={3}>
              <Button
                type="submit"
                disabled={create.isPending || (source === 'existing' && available.length === 0)}
              >
                {create.isPending ? t('projects.form.adding') : t('projects.form.submit')}
              </Button>
            </Inline>

            {serverError && <Alert>{serverError}</Alert>}
          </Stack>
        </form>
      </Stack>
    </Card>
  )
}
