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
import { formatDateTime, formatDayLabel, formatTimeOfDay } from '@/shared/lib/date'
import { Input } from '@/shared/ui/input'
import { type Session, useDeleteSession } from '../hooks/use-sessions'
import {
  activityTime,
  type SessionGroupHeading,
  sessionGroupOf,
  sortSessions,
} from '../lib/session-groups'
import { STATUS_TONE } from '../lib/status'

const columnHelper = createColumnHelper<Session>()

/**
 * The project's sessions, replacing the old card grid. A shadcn `DataTable`
 * over a plain TanStack v8 instance (`ProjectsTable`'s own shape), so it
 * inherits sorting-free, pagination-free behaviour for free — the one order
 * this ever shows is last activity, newest first (`sortSessions`), split under
 * plain Today / Yesterday / per-day / Older headings. Search filters first and
 * a heading whose sessions were all filtered out goes with them.
 */
export function SessionsTable({ sessions, projectId }: { sessions: Session[]; projectId: string }) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage
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
      // Time only under Today / Yesterday / a day heading — the heading is
      // already the date — and the full date and time under Older, whose
      // heading says nothing about it. `title` carries the full one either
      // way, so a bare `14:32` can still be read in full on hover.
      columnHelper.accessor((session) => activityTime(session), {
        id: 'updated',
        header: () => t('sessions.table.updated'),
        meta: { role: 'meta' },
        cell: (info) => {
          const value = info.getValue()
          const full = formatDateTime(value, language)
          const older = sessionGroupOf(info.row.original, new Date()).kind === 'older'
          return (
            <span title={full || undefined}>{older ? full : formatTimeOfDay(value, language)}</span>
          )
        },
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
    [t, language, navigate, projectId],
  )

  // The API already answers newest-activity first; sorting here too means the
  // order doesn't depend on whatever arrives in the cache. Memoised on the
  // array itself so TanStack sees a stable `data` between renders.
  const sorted = useMemo(() => sortSessions(sessions), [sessions])

  const table = useReactTable({
    data: sorted,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // Judged against the clock at each render rather than when the data
  // arrived, so a list left open past midnight regroups on its next render
  // (a refetch, a keystroke in the search box) instead of staying frozen on
  // yesterday's "Today".
  const now = new Date()
  const groupLabel = (heading: SessionGroupHeading) => {
    switch (heading.kind) {
      case 'today':
        return t('sessions.groups.today')
      case 'yesterday':
        return t('sessions.groups.yesterday')
      case 'day':
        return formatDayLabel(heading.day, language)
      case 'older':
        return t('sessions.groups.older')
    }
  }

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

      <DataTable
        table={table}
        empty={<span>{t('sessions.noMatches')}</span>}
        groupBy={(session) => {
          const heading = sessionGroupOf(session, now)
          return { key: heading.key, label: groupLabel(heading) }
        }}
      />

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
