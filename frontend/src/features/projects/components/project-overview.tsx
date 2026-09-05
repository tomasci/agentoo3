import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshKeys } from '@/features/ssh-keys'
import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmDialog,
  type DefinitionItem,
  DefinitionList,
  Inline,
  Input,
  PageHeader,
  Select,
  type SelectOption,
  Spinner,
  Stack,
  toast,
} from '@/shared/ui'
import {
  type Project,
  useDeleteProject,
  useRetryProject,
  useUpdateProject,
} from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { isSshRemote } from '../lib/remote-url'
import styles from './project-overview.module.scss'
import { ProjectStatusBadge } from './project-status'
import { RecoveryPanel } from './recovery-panel'

/**
 * The project's own page: what it is, how it authenticates, and how to remove it.
 *
 * Deleting is reported through `onDeleted` rather than acted on here: the
 * project was opened in a tab, and it is the tab — not this page — that has to
 * decide where the reader ends up once its subject is gone.
 */
export function ProjectOverview({
  project,
  onDeleted,
}: {
  project: Project
  onDeleted?: () => void
}) {
  const { t } = useTranslation()
  const { data: sshKeys } = useSshKeys()
  const update = useUpdateProject()
  const retry = useRetryProject()
  const remove = useDeleteProject()

  const [keyId, setKeyId] = useState(project.sshKeyId ?? '')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [branchInput, setBranchInput] = useState(project.defaultBranch ?? '')
  const [branchError, setBranchError] = useState<string | null>(null)
  const updateBranch = useUpdateProject()

  // Keep the select honest if the project changes under us — a poll, or the
  // recovery panel swapping the key.
  useEffect(() => {
    setKeyId(project.sshKeyId ?? '')
  }, [project.sshKeyId])

  useEffect(() => {
    setBranchInput(project.defaultBranch ?? '')
  }, [project.defaultBranch])

  const changeKey = (next: string) => {
    setKeyId(next)
    setKeyError(null)
    update.mutate(
      { path: { id: project.id }, body: { sshKeyId: next || null } },
      {
        onSuccess: () => toast({ title: t('projects.keySaved') }),
        onError: (error) => setKeyError(apiErrorMessage(error, t('projects.keyChangeFailed'))),
      },
    )
  }

  const saveDefaultBranch = () => {
    setBranchError(null)
    const trimmed = branchInput.trim()
    updateBranch.mutate(
      // Empty clears it back to auto-detect — sending "" would ask the
      // server to set the branch to the empty string, not unset it.
      { path: { id: project.id }, body: { defaultBranch: trimmed || null } },
      {
        onSuccess: () => toast({ title: t('projects.branchSaved') }),
        onError: (error) =>
          setBranchError(apiErrorMessage(error, t('projects.branchChangeFailed'))),
      },
    )
  }

  const keyOptions: SelectOption[] = [
    { value: '', label: t('projects.form.sshKeyNone') },
    ...(sshKeys ?? []).map((k) => ({
      value: k.id,
      label: k.comment ? `${k.name} — ${k.comment}` : k.name,
    })),
  ]

  const facts: DefinitionItem[] = [
    { id: 'path', term: t('projects.meta.path'), description: <Code wrap>{project.path}</Code> },
    {
      id: 'source',
      term: t('projects.overview.source'),
      description: t(`projects.overview.source_${project.source}`),
    },
    ...(project.remoteUrl
      ? [
          {
            id: 'remote',
            term: t('projects.meta.remote'),
            description: <Code wrap>{project.remoteUrl}</Code>,
          },
        ]
      : []),
    {
      id: 'branch',
      term: t('projects.meta.branch'),
      // No default is exactly the project whose owner needs this control, so
      // it stays in the list — never omitted — when the value is null.
      description: (
        <Stack gap={2} align="start">
          <Inline gap={2}>
            <Input
              mono
              aria-label={t('projects.meta.branch')}
              value={branchInput}
              onChange={(e) => {
                setBranchInput(e.target.value)
                setBranchError(null)
              }}
              placeholder={t('projects.branchPlaceholder')}
            />
            <Button
              type="button"
              size="sm"
              loading={updateBranch.isPending}
              loadingLabel={t('common.working')}
              onClick={saveDefaultBranch}
            >
              {t('common.save')}
            </Button>
          </Inline>
          {branchError ? (
            <Alert tone="danger">{branchError}</Alert>
          ) : (
            <p className={styles.hint}>{t('projects.branchHint')}</p>
          )}
        </Stack>
      ),
    },
  ]

  return (
    <Stack gap={5}>
      <PageHeader title={project.name} actions={<ProjectStatusBadge project={project} />} />

      <Card>
        <Stack gap={3}>
          <h3 className={styles.cardTitle}>{t('projects.overview.details')}</h3>
          <DefinitionList items={facts} />
        </Stack>
      </Card>

      {project.source === 'clone' && isSshRemote(project.remoteUrl) && (
        <Card>
          <Stack gap={3}>
            <h3 className={styles.cardTitle}>{t('projects.overview.authentication')}</h3>
            <Inline gap={3}>
              <Select
                options={keyOptions}
                value={keyId}
                onValueChange={(next) => changeKey(next ?? '')}
                disabled={update.isPending}
              />
              {update.isPending && <Spinner label={t('projects.savingKey')} size="sm" />}
            </Inline>
            {keyError && <Alert tone="danger">{keyError}</Alert>}
            <p className={styles.hint}>{t('projects.keyRetryHint')}</p>
          </Stack>
        </Card>
      )}

      <Card>
        <Stack gap={3}>
          <h3 className={styles.cardTitle}>{t('projects.overview.setup')}</h3>
          <Inline gap={2}>
            <Button
              type="button"
              loading={retry.isPending}
              loadingLabel={t('projects.recovery.checking')}
              onClick={() => retry.mutate({ path: { id: project.id } })}
            >
              {t('projects.retry')}
            </Button>
            <span className={styles.hint}>{t('projects.overview.retryHint')}</span>
          </Inline>
          {project.status === 'failed' && project.lastError && (
            <Alert tone="danger">{project.lastError}</Alert>
          )}
          {project.status === 'needs_manual' && <RecoveryPanel project={project} />}
        </Stack>
      </Card>

      <Card tone="danger">
        <Stack gap={2}>
          <h3 className={styles.dangerTitle}>{t('projects.overview.danger')}</h3>
          <p className={styles.hint}>
            {project.source === 'clone'
              ? t('projects.overview.deleteCloneHint')
              : t('projects.overview.deleteExistingHint')}
          </p>
          <Inline gap={2}>
            <Button type="button" onClick={() => setConfirmDelete(true)}>
              {t('projects.overview.deleteProject')}
            </Button>
          </Inline>
        </Stack>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('projects.delete.title')}
        description={
          project.source === 'clone'
            ? t('projects.delete.confirmClone', { name: project.name })
            : t('projects.delete.confirmExisting', { name: project.name })
        }
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            {
              path: { id: project.id },
              query: { removeFiles: project.source === 'clone' ? 'true' : 'false' },
            },
            { onSuccess: () => onDeleted?.() },
          )
        }
      />
    </Stack>
  )
}
