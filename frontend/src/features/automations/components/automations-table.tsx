import { Link } from '@tanstack/react-router'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, ConfirmDialog, DataTable, type MenuAction, toast } from '@/shared/components'
import { zoneWithOffset } from '@/shared/lib/timezones'
import { Switch } from '@/shared/ui/switch'
import { type Automation, useDeleteAutomation, useUpdateAutomation } from '../hooks/use-automations'
import { formatInZone } from '../lib/format'
import { describeSchedule } from '../lib/schedule'

const columnHelper = createColumnHelper<Automation>()

/** The Active/Paused `Switch` — its own mutation instance per row (rather
 *  than one shared across the table, the way `SessionsTable`'s single
 *  delete mutation serves every row) so toggling one automation never
 *  visually disables every other row's switch while it settles. */
function PausedSwitch({ automation, projectId }: { automation: Automation; projectId: string }) {
  const { t } = useTranslation()
  const update = useUpdateAutomation(projectId)

  return (
    <Switch
      aria-label={
        automation.paused
          ? t('automations.table.resume', { name: automation.name })
          : t('automations.table.pause', { name: automation.name })
      }
      checked={!automation.paused}
      disabled={update.isPending}
      onCheckedChange={(checked) =>
        update.mutate(
          { path: { id: automation.id }, body: { paused: !checked } },
          {
            onError: (e) =>
              toast.add({
                type: 'error',
                title: apiErrorMessage(e, t('automations.table.pauseFailed')),
              }),
          },
        )
      }
    />
  )
}

function RowActions({
  automation,
  projectId,
  onEdit,
}: {
  automation: Automation
  projectId: string
  onEdit: (automation: Automation) => void
}) {
  const { t } = useTranslation()
  const update = useUpdateAutomation(projectId)
  const remove = useDeleteAutomation(projectId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const pauseLabel = automation.paused
    ? t('automations.table.resume', { name: automation.name })
    : t('automations.table.pause', { name: automation.name })

  const actions: MenuAction[] = [
    { id: 'edit', label: t('common.edit'), onSelect: () => onEdit(automation) },
    {
      id: 'toggle-paused',
      label: pauseLabel,
      onSelect: () =>
        update.mutate(
          { path: { id: automation.id }, body: { paused: !automation.paused } },
          {
            onError: (e) =>
              toast.add({
                type: 'error',
                title: apiErrorMessage(e, t('automations.table.pauseFailed')),
              }),
          },
        ),
    },
    {
      id: 'delete',
      label: t('common.delete'),
      destructive: true,
      onSelect: () => setConfirmDelete(true),
    },
  ]

  return (
    <>
      <ActionsMenu
        actions={actions}
        label={t('automations.table.actionsFor', { name: automation.name })}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('automations.delete.title')}
        description={t('automations.delete.confirm', { name: automation.name })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { path: { id: automation.id } },
            {
              onError: (e) =>
                toast.add({
                  type: 'error',
                  title: apiErrorMessage(e, t('automations.delete.failed')),
                }),
              onSettled: () => setConfirmDelete(false),
            },
          )
        }
      />
    </>
  )
}

export function AutomationsTable({
  automations,
  projectId,
  onEdit,
}: {
  automations: Automation[]
  projectId: string
  onEdit: (automation: Automation) => void
}) {
  const { t } = useTranslation()

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('automations.table.name'),
        meta: { role: 'secondary' },
        cell: (info) => (
          <Link
            to="/projects/$projectId/automations/$automationId"
            params={{ projectId, automationId: info.row.original.id }}
            className="block truncate font-medium text-foreground hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      columnHelper.display({
        id: 'schedule',
        header: () => t('automations.table.schedule'),
        meta: { role: 'meta' },
        cell: (info) => describeSchedule(info.row.original.cron, t),
      }),
      columnHelper.accessor('timezone', {
        header: () => t('automations.table.timezone'),
        meta: { role: 'meta' },
        cell: (info) => zoneWithOffset(info.getValue()),
      }),
      columnHelper.display({
        id: 'nextRun',
        header: () => t('automations.table.nextRun'),
        meta: { role: 'meta' },
        cell: (info) => {
          const { paused, nextRunAt, timezone } = info.row.original
          return paused
            ? t('automations.paused')
            : nextRunAt
              ? formatInZone(nextRunAt, timezone)
              : ''
        },
      }),
      columnHelper.accessor('lastRunAt', {
        header: () => t('automations.table.lastRun'),
        meta: { role: 'meta' },
        cell: (info) => {
          const lastRunAt = info.getValue()
          return lastRunAt
            ? formatInZone(lastRunAt, info.row.original.timezone)
            : t('automations.never')
        },
      }),
      columnHelper.accessor('runCount', {
        header: () => t('automations.table.runCount'),
        meta: { role: 'meta' },
      }),
      columnHelper.display({
        id: 'paused',
        header: () => t('automations.table.active'),
        meta: { role: 'meta' },
        cell: (info) => <PausedSwitch automation={info.row.original} projectId={projectId} />,
      }),
      columnHelper.display({
        id: 'actions',
        header: () => '',
        meta: { role: 'actions' },
        cell: (info) => (
          <RowActions automation={info.row.original} projectId={projectId} onEdit={onEdit} />
        ),
      }),
    ],
    [t, projectId, onEdit],
  )

  const table = useReactTable({ data: automations, columns, getCoreRowModel: getCoreRowModel() })

  return <DataTable table={table} />
}
