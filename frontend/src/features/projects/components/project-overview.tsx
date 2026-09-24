import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDockerDetection } from '@/features/docker'
import { useSshKeys } from '@/features/ssh-keys'
import {
  Code,
  ConfirmDialog,
  type DefinitionItem,
  DefinitionList,
  Loading,
  PageHeader,
  toast,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import {
  type Project,
  useDeleteProject,
  useRetryProject,
  useUpdateProject,
} from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { isSshRemote } from '../lib/remote-url'
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
  // One call covering every project, the same query the projects table's
  // own indicator uses (projects-table.tsx) — detection changes on the
  // scale of a commit, so this fact is worth showing without a dedicated
  // per-project poll.
  const detection = useDockerDetection()
  const dockerDetected = detection.data?.projects.find((p) => p.projectId === project.id)
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
        onSuccess: () => toast.add({ title: t('projects.keySaved'), type: 'success' }),
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
        onSuccess: () => toast.add({ title: t('projects.branchSaved'), type: 'success' }),
        onError: (error) =>
          setBranchError(apiErrorMessage(error, t('projects.branchChangeFailed'))),
      },
    )
  }

  const keyOptions = [
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
      id: 'docker',
      term: t('projects.overview.docker.fact'),
      description: (
        <div className="flex items-center gap-2">
          <span>
            {dockerDetected?.hasCompose || dockerDetected?.hasDockerfile
              ? t('projects.overview.docker.detected')
              : t('projects.overview.docker.notDetected')}
          </span>
          <Link to="/projects/$projectId/docker" params={{ projectId: project.id }}>
            {t('projects.overview.docker.openDocker')}
          </Link>
        </div>
      ),
    },
    {
      id: 'branch',
      term: t('projects.meta.branch'),
      // No default is exactly the project whose owner needs this control, so
      // it stays in the list — never omitted — when the value is null.
      description: (
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <Input
              className="font-mono"
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
              disabled={updateBranch.isPending}
              onClick={saveDefaultBranch}
            >
              {updateBranch.isPending && <Spinner data-icon="inline-start" />}
              {t('common.save')}
            </Button>
          </div>
          {branchError ? (
            <Alert variant="destructive">
              <AlertDescription>{branchError}</AlertDescription>
            </Alert>
          ) : (
            <p className="text-xs text-muted-foreground">{t('projects.branchHint')}</p>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={project.name} actions={<ProjectStatusBadge project={project} />} />

      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.details')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DefinitionList items={facts} />
        </CardContent>
      </Card>

      {project.source === 'clone' && isSshRemote(project.remoteUrl) && (
        <Card>
          <CardHeader>
            <CardTitle>{t('projects.overview.authentication')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Select
                items={keyOptions}
                value={keyId}
                onValueChange={(next) => changeKey(next ?? '')}
                disabled={update.isPending}
              >
                {/* Key names (plus an optional free-text comment) can run
                    long — a bounded, shrinkable width keeps this from
                    crowding the spinner beside it, with an ellipsis for
                    whatever still overflows. */}
                <SelectTrigger aria-label={t('projects.form.sshKey')} className="min-w-0 max-w-56">
                  <SelectValue className="min-w-0 truncate" />
                </SelectTrigger>
                <SelectContent>
                  {keyOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="min-w-0 flex-1 truncate" title={option.label}>
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {update.isPending && <Loading label={t('projects.savingKey')} />}
            </div>
            {keyError && (
              <Alert variant="destructive">
                <AlertDescription>{keyError}</AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">{t('projects.keyRetryHint')}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.setup')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ path: { id: project.id } })}
            >
              {retry.isPending && <Spinner data-icon="inline-start" />}
              {t('projects.retry')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('projects.overview.retryHint')}
            </span>
          </div>
          {project.status === 'failed' && project.lastError && (
            <Alert variant="destructive">
              <AlertDescription>{project.lastError}</AlertDescription>
            </Alert>
          )}
          {project.status === 'needs_manual' && <RecoveryPanel project={project} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.danger')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {project.source === 'clone'
              ? t('projects.overview.deleteCloneHint')
              : t('projects.overview.deleteExistingHint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
              {t('projects.overview.deleteProject')}
            </Button>
          </div>
        </CardContent>
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
    </div>
  )
}
