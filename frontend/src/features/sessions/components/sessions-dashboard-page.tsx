import { Link } from '@tanstack/react-router'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { DataTable, Loading, PageHeader, StatusBadge } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Card, CardContent } from '@/shared/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group'
import {
  type OverviewSession,
  type OverviewWindow,
  useSessionsOverview,
} from '../hooks/use-sessions'
import { formatDateTime } from '../lib/format'
import { STATUS_TONE } from '../lib/status'

const WINDOWS: OverviewWindow[] = ['1d', '3d', '7d']

/** Which of `OverviewSession`'s two timestamps a section's own time column
 *  reads — see `useOverviewColumns`' own comment on why it differs by section. */
type TimeField = 'updatedAt' | 'settledAt'

const columnHelper = createColumnHelper<OverviewSession>()

/**
 * The columns every section's table shares — only the time column differs.
 * Running and Recent read as "when did this last do anything" (`updatedAt`);
 * Unchecked reads as "when did it stop" (`settledAt`), which is the actual
 * question a result waiting to be checked is asking.
 *
 * `timeHeader` arrives already translated, not as a key: this hook has no
 * opinion of its own about which label goes with which field, and taking a
 * plain string keeps that decision entirely at the call site.
 */
function useOverviewColumns(timeField: TimeField, timeHeader: string) {
  const { t } = useTranslation()
  return useMemo(
    () => [
      // Same shape as `SessionsTable`'s own title column (sessions-table.tsx):
      // the untitled fallback as the accessor's own value, `'secondary'` so a
      // long title truncates instead of forcing horizontal scroll.
      columnHelper.accessor(
        (session) => session.title ?? t('sessions.untitled', { id: session.id.slice(0, 8) }),
        {
          id: 'title',
          header: () => t('sessions.table.title'),
          meta: { role: 'secondary' },
          cell: (info) => (
            <Link
              to="/projects/$projectId/sessions/$sessionId"
              params={{ projectId: info.row.original.projectId, sessionId: info.row.original.id }}
              className="block truncate font-medium text-foreground hover:underline"
            >
              {info.getValue()}
            </Link>
          ),
        },
      ),
      columnHelper.accessor('projectName', {
        header: () => t('sessions.dashboard.table.project'),
        meta: { role: 'meta' },
        cell: (info) => info.getValue(),
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
      // A function accessor, not `columnHelper.accessor(timeField, ...)`: the
      // field name only exists at runtime here (it is this hook's own
      // parameter), and a plain function keeps the cell's value typed as
      // `string | null` regardless of which of the two fields it reads,
      // rather than fighting the column helper's key-based overload for a
      // union of keys.
      columnHelper.accessor((session) => session[timeField], {
        id: 'time',
        header: () => timeHeader,
        meta: { role: 'meta' },
        cell: (info) => {
          const value = info.getValue()
          return value ? formatDateTime(value) : ''
        },
      }),
    ],
    [t, timeField, timeHeader],
  )
}

/**
 * One section's table, or its own quiet empty line — never both, and never a
 * table with an "empty" slot of its own: three of those stacked on one page
 * is the loud version of the same fact a single sentence already says.
 */
function OverviewTable({
  sessions,
  timeField,
  timeHeader,
  emptyLabel,
}: {
  sessions: OverviewSession[]
  timeField: TimeField
  timeHeader: string
  emptyLabel: string
}) {
  const columns = useOverviewColumns(timeField, timeHeader)
  const table = useReactTable({ data: sessions, columns, getCoreRowModel: getCoreRowModel() })

  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  return <DataTable table={table} />
}

/**
 * The System tab's default page (`SYSTEM_HOME`, shared/store/tabs.ts):
 * running, unchecked and recent sessions, across every project, so "which
 * project did I leave that in" never has to be remembered by hand.
 *
 * Order is actionable first, history last: Running is happening right now,
 * Unchecked is a result waiting on the operator, Recent is just what
 * happened lately (and may repeat a session already listed above it — the
 * backend's own contract, not a bug here).
 */
export function SessionsDashboardPage() {
  const { t } = useTranslation()
  const [activeWindow, setActiveWindow] = useState<OverviewWindow>('1d')
  const overview = useSessionsOverview(activeWindow)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('sessions.dashboard.heading')}
        description={t('sessions.dashboard.lead')}
      />

      {overview.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(overview.error, t('sessions.dashboard.loadFailed'))}
          </AlertDescription>
        </Alert>
      )}
      {!overview.isError && overview.isPending && <Loading label={t('common.loading')} block />}
      {!overview.isError && overview.data && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">
                {t('sessions.dashboard.running.heading', { count: overview.data.running.length })}
              </h2>
              <OverviewTable
                sessions={overview.data.running}
                timeField="updatedAt"
                timeHeader={t('sessions.dashboard.table.lastActivity')}
                emptyLabel={t('sessions.dashboard.running.empty')}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">
                {t('sessions.dashboard.unchecked.heading', {
                  count: overview.data.unchecked.length,
                })}
              </h2>
              <OverviewTable
                sessions={overview.data.unchecked}
                timeField="settledAt"
                timeHeader={t('sessions.dashboard.table.finished')}
                emptyLabel={t('sessions.dashboard.unchecked.empty')}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">
                  {t('sessions.dashboard.recent.heading', { count: overview.data.recent.length })}
                </h2>
                <ToggleGroup
                  aria-label={t('sessions.dashboard.recent.windowLabel')}
                  variant="outline"
                  size="sm"
                  spacing={2}
                  value={[activeWindow]}
                  onValueChange={(next) => {
                    // Base UI represents a single-select group as a
                    // 0-or-1-length array; a click on the already-pressed
                    // item reports the empty one, which must leave the
                    // window exactly where it was rather than land on none
                    // pressed — see `CreateProjectForm`'s own `ToggleGroup`
                    // for the same guard.
                    const value = next[0]
                    if (value) setActiveWindow(value as OverviewWindow)
                  }}
                >
                  {WINDOWS.map((value) => (
                    <ToggleGroupItem key={value} value={value}>
                      {t(`sessions.dashboard.recent.window.${value}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <OverviewTable
                sessions={overview.data.recent}
                timeField="updatedAt"
                timeHeader={t('sessions.dashboard.table.lastActivity')}
                emptyLabel={t('sessions.dashboard.recent.empty')}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
