import { Link, useNavigate } from '@tanstack/react-router'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  ConfirmDialog,
  DataTable,
  type MenuAction,
  StatusBadge,
  toast,
} from '@/shared/components'
import { Input } from '@/shared/ui/input'
import { type Session, useDeleteSession } from '../hooks/use-sessions'
import { formatDateTime } from '../lib/format'
import { STATUS_TONE } from '../lib/status'

const columnHelper = createColumnHelper<Session>()

/**
 * The project's sessions, replacing the old card grid. A shadcn `DataTable`
 * over a plain TanStack v8 instance (`ProjectsTable`'s own shape), so it
 * inherits sorting-free, pagination-free behaviour for free — the API's own
 * `createdAt desc` order is the only order this ever shows.
 */
export function SessionsTable({ sessions, projectId }: { sessions: Session[]; projectId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const remove = useDeleteSession(projectId)
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)

  const columns = useMemo(
    () => [
      // The accessor is the *displayed* title, untitled fallback included —
      // search matches what the reader sees in this column, not the raw
      // (possibly null) title underneath it. `role: 'secondary'`, not
      // `'primary'`: a title runs up to 200 chars, every cell inherits
      // `whitespace-nowrap` from `ui/table`, and `'primary'` gets no
      // width/truncation class in data-table.tsx — one long title forced
      // horizontal scroll and pushed Status/Actions off-screen. `'secondary'`
      // is that file's own mechanism for exactly this (`lg:max-w-0
      // lg:truncate` on the cell, plus a `title` attribute carrying this same
      // accessor's full string so the untruncated name is still reachable) —
      // the same trade the old per-session card's own title link used to
      // make. `block truncate` on the `Link` itself too: a `Link` renders an
      // inline `<a>`, and while the `<td>`'s own `text-overflow` already
      // ellipsizes an overflowing inline child regardless of what tag it is,
      // making the anchor its own truncating box keeps this correct even if
      // the cell ever grows a second child alongside it.
      columnHelper.accessor(
        (session) => session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) }),
        {
          id: 'title',
          header: () => t('sessions.table.title'),
          meta: { role: 'secondary' },
          cell: (info) => (
            <Link
              to="/projects/$projectId/sessions/$sessionId"
              params={{ projectId, sessionId: info.row.original.id }}
              className="block truncate font-medium text-foreground hover:underline"
            >
              {info.getValue()}
            </Link>
          ),
        },
      ),
      columnHelper.accessor('createdAt', {
        header: () => t('sessions.table.date'),
        meta: { role: 'meta' },
        cell: (info) => formatDateTime(info.getValue()),
      }),
      columnHelper.accessor('status', {
        header: () => t('sessions.table.status'),
        meta: { role: 'meta' },
        cell: (info) => (
          <StatusBadge tone={STATUS_TONE[info.getValue()]}>
            {t(`sessions.status.${info.getValue()}`)}
          </StatusBadge>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => '',
        meta: { role: 'actions' },
        cell: (info) => {
          const session = info.row.original
          const actions: MenuAction[] = [
            {
              id: 'open',
              label: t('sessions.open'),
              onSelect: () =>
                void navigate({
                  to: '/projects/$projectId/sessions/$sessionId',
                  params: { projectId, sessionId: session.id },
                }),
            },
            {
              id: 'delete',
              label: t('common.delete'),
              destructive: true,
              onSelect: () => setPendingDelete(session),
            },
          ]
          return (
            <ActionsMenu
              actions={actions}
              label={t('sessions.actionsFor', {
                name: session.title ?? session.id.slice(0, 8),
              })}
            />
          )
        },
      }),
    ],
    [t, navigate, projectId],
  )

  const table = useReactTable({
    data: sessions,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // The title column's own filter value doubles as the search box's state —
  // one source of truth rather than a second `useState` that could drift
  // from it.
  const titleColumn = table.getColumn('title')
  const search = (titleColumn?.getFilterValue() as string | undefined) ?? ''

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={search}
        onChange={(e) => titleColumn?.setFilterValue(e.target.value)}
        placeholder={t('sessions.searchPlaceholder')}
        aria-label={t('sessions.searchPlaceholder')}
        className="max-w-sm"
      />

      <DataTable table={table} empty={<span>{t('sessions.noMatches')}</span>} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('sessions.deleteTitle')}
        description={t('sessions.deleteConfirm')}
        busy={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(
            { path: { id: pendingDelete.id } },
            {
              onError: (e) =>
                toast.add({
                  type: 'error',
                  title: apiErrorMessage(e, t('sessions.deleteFailed')),
                }),
              onSettled: () => setPendingDelete(null),
            },
          )
        }}
      />
    </div>
  )
}
