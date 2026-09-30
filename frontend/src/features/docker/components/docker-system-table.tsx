import { Link } from '@tanstack/react-router'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ConfirmDialog, DataTable, StatusBadge, toast } from '@/shared/components'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import { useStopDockerSystemContainer } from '../hooks/use-docker-system'
import { CONTAINER_HEALTH_TONE, isOperationConflict } from '../lib/state'
import {
  containerStatus,
  formatPorts,
  STOPPABLE_STATES,
  type SystemContainer,
  type SystemContainerOwner,
  showsHealth,
} from '../lib/system'

const columnHelper = createColumnHelper<SystemContainer>()

type T = (key: string, opts?: Record<string, unknown>) => string

/** The session half of an owner's own line — title, falling back to the same
 *  untitled-session pattern `docker-scope-bar.tsx`'s `sessionLabel` uses, or
 *  (for the project's own repo/ checkout, which has no session at all) the
 *  branch it's checked out on, if the daemon reported one. */
function ownerSubtitle(owner: SystemContainerOwner, t: T): string | null {
  if (owner.sessionId) {
    return owner.sessionTitle ?? t('sessions.untitled', { id: owner.sessionId.slice(0, 8) })
  }
  return owner.branch
}

function OwnerCell({ owner }: { owner: SystemContainerOwner | null }) {
  const { t } = useTranslation()
  // No owner label this install recognises (or the project/session it named
  // is gone) — no link, per this page's own contract; a plain dash reads as
  // "nothing to show" the same way every other empty table cell here does.
  if (!owner) return <span className="text-muted-foreground">—</span>

  const subtitle = ownerSubtitle(owner, t)

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{owner.projectName}</span>
        {owner.kind === 'editor' && (
          <StatusBadge tone="neutral">{t('docker.system.owner.editor')}</StatusBadge>
        )}
      </div>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      {/* `sessionId === null` is the project's own repo/ checkout
          (backend/src/features/docker/scope.ts) — its Docker page is
          `/projects/$projectId/docker`; every other owner points at that
          session's own worktree instead, one path segment further in. */}
      {owner.sessionId === null ? (
        <Link
          to="/projects/$projectId/docker"
          params={{ projectId: owner.projectId }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('docker.system.owner.open')}
        </Link>
      ) : (
        <Link
          to="/projects/$projectId/sessions/$sessionId/docker"
          params={{ projectId: owner.projectId, sessionId: owner.sessionId }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('docker.system.owner.open')}
        </Link>
      )}
    </div>
  )
}

/**
 * One row's Stop button, its own confirm dialog and its own pending state —
 * the same per-row shape `running-editors.tsx`'s `EditorRow` uses, so
 * stopping one container never disables, or shows a spinner on, any other
 * row.
 *
 * Renders nothing at all for a state Stop makes no sense for
 * (`STOPPABLE_STATES`) — not a disabled button, which would invite "why
 * can't I stop an already-stopped container" for every row instead of just
 * the one real reason (`enabled` below).
 */
function StopCell({ container, enabled }: { container: SystemContainer; enabled: boolean }) {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const stop = useStopDockerSystemContainer()

  if (!STOPPABLE_STATES.has(container.state)) return null

  const doStop = () =>
    stop.mutate(
      { path: { containerId: container.id } },
      {
        onSuccess: () => {
          setConfirmOpen(false)
          toast.add({
            title: t('docker.system.stopSucceeded', { name: container.name }),
            type: 'success',
          })
        },
        onError: (error) => {
          setConfirmOpen(false)
          toast.add({
            title: isOperationConflict(error)
              ? t('docker.system.stopConflict')
              : apiErrorMessage(error, t('docker.system.stopFailed', { name: container.name })),
            type: 'error',
          })
        },
      },
    )

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!enabled || stop.isPending}
        title={enabled ? undefined : t('docker.system.stopDisabledReason')}
        onClick={() => setConfirmOpen(true)}
      >
        {stop.isPending && <Spinner data-icon="inline-start" />}
        {t('docker.system.stop')}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('docker.system.stopConfirmTitle', { name: container.name })}
        description={t('docker.system.stopConfirmBody')}
        confirmLabel={t('docker.system.stop')}
        busy={stop.isPending}
        onConfirm={doStop}
      />
    </>
  )
}

/**
 * The System tab's Docker page's own table — every container on the host,
 * already sorted (docker-system-page.tsx's `sortSystemContainers`), one row
 * each. A shadcn `DataTable` over a plain TanStack v8 instance, the same
 * shape `SessionsTable` (features/sessions/components/sessions-table.tsx)
 * uses: no sorting or filtering of its own, since the caller's own sort is
 * the only order this ever shows.
 */
export function DockerSystemTable({
  containers,
  enabled,
}: {
  containers: SystemContainer[]
  /** `daemon.enabled` (GetApiDockerContainers) — false disables every row's
   *  Stop button, per this page's own contract. */
  enabled: boolean
}) {
  const { t } = useTranslation()

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('docker.system.table.name'),
        meta: { role: 'secondary' },
        cell: (info) => {
          const container = info.row.original
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium text-foreground">{container.name}</span>
              <span className="truncate text-xs text-muted-foreground">{container.image}</span>
              {container.composeProject && (
                <span className="truncate text-xs text-muted-foreground">
                  {container.composeProject}
                </span>
              )}
            </div>
          )
        },
      }),
      columnHelper.display({
        id: 'status',
        header: () => t('docker.system.table.status'),
        cell: (info) => {
          const container = info.row.original
          const status = containerStatus(container, t)
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              {showsHealth(container) && (
                <StatusBadge tone={CONTAINER_HEALTH_TONE[container.health]}>
                  {t(`docker.state.health.${container.health}`)}
                </StatusBadge>
              )}
            </div>
          )
        },
      }),
      columnHelper.display({
        id: 'ports',
        header: () => t('docker.system.table.ports'),
        meta: { role: 'meta' },
        cell: (info) => formatPorts(info.row.original.ports),
      }),
      columnHelper.display({
        id: 'owner',
        header: () => t('docker.system.table.owner'),
        cell: (info) => <OwnerCell owner={info.row.original.owner} />,
      }),
      columnHelper.display({
        id: 'actions',
        header: () => '',
        meta: { role: 'actions' },
        cell: (info) => <StopCell container={info.row.original} enabled={enabled} />,
      }),
    ],
    [t, enabled],
  )

  const table = useReactTable({ data: containers, columns, getCoreRowModel: getCoreRowModel() })

  return <DataTable table={table} />
}
