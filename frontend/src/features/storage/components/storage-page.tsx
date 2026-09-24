import { Link } from '@tanstack/react-router'
import {
  type Column,
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { useSession } from '@/features/sessions'
import { formatBytes } from '@/features/system'
import {
  ActionsMenu,
  Code,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  Loading,
  type MenuAction,
  PageHeader,
  StatusBadge,
  toast,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group'
import {
  ANOMALY_CLASSES,
  type AnomalyClass,
  type AnomalyRemediation,
  type StorageAnomaly,
  type TopSession,
  useBulkDeleteAnomalies,
  useBulkResolveAnomalies,
  useDeleteAnomaly,
  useRecheckAnomaly,
  useResolveAnomaly,
  useRunStorageCheck,
  useRunStorageCleanup,
  useStorageAnomalies,
  useStorageSummary,
} from '../hooks/use-storage'
import { ANOMALY_TONE } from '../lib/classes'
import { cleanupPlanFor } from '../lib/cleanup-plan'
import { formatDateTime } from '../lib/format'
import { OUTCOME_TONE, tallyOutcomes } from '../lib/outcomes'

const columnHelper = createColumnHelper<StorageAnomaly>()
const topSessionsColumnHelper = createColumnHelper<TopSession>()

// A toast only ever carries three of `Tone`'s five values (see OUTCOME_TONE in
// lib/outcomes.ts) — this is the one place that vocabulary crosses into
// `toast.add`'s own, narrower one (old tones: success→success, danger→error,
// accent→info).
const OUTCOME_TOAST_TYPE: Record<'success' | 'accent' | 'danger', 'success' | 'info' | 'error'> = {
  success: 'success',
  accent: 'info',
  danger: 'error',
}

/** A column header that also toggles that column's sort — `DataTable` itself
 * renders whatever a column's own `header` returns, so a clickable, stateful
 * header is a per-column concern, not something the shared table needs to
 * know about. */
function SortableHeader({
  label,
  column,
}: {
  label: string
  column: Column<StorageAnomaly, unknown>
}) {
  const sorted = column.getIsSorted()
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={column.getToggleSortingHandler()}
    >
      {label}
      {sorted === 'asc' && <ArrowUpIcon className="size-3" />}
      {sorted === 'desc' && <ArrowDownIcon className="size-3" />}
    </button>
  )
}

/** A session id, upgraded to a link once (id, still-existing) is confirmed —
 * `GET /sessions/:id` is the only place a session's `projectId` comes from,
 * so this costs one request per distinct session an anomaly (or a top-usage
 * row) names. */
function SessionRefLink({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const short = sessionId.slice(0, 8)

  if (session.isPending) return <Code>{short}</Code>
  if (session.isError || !session.data) {
    return (
      <span className="text-sm text-muted-foreground">
        {t('storage.anomalies.sessionGone', { id: short })}
      </span>
    )
  }
  return (
    <Link
      to="/projects/$projectId/sessions/$sessionId"
      params={{ projectId: session.data.projectId, sessionId }}
    >
      {session.data.title ?? short}
    </Link>
  )
}

function SessionRef({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return <span className="text-sm text-muted-foreground">—</span>
  return <SessionRefLink sessionId={sessionId} />
}

type View = 'open' | 'resolved'

/** Toasts the one honest fact a remediation response carries: `outcome` is
 * never just "the thing I asked for" — a `delete` re-verifies before acting,
 * so `revalidated` (fixed itself, nothing removed) and `failed` are just as
 * likely an answer as `deleted`, and reporting either of those as a plain
 * success would be lying about what actually happened. Shared between the
 * per-row delete and per-row recheck actions, which answer with the exact
 * same shape. */
function reportOutcome(t: (key: string) => string, result: AnomalyRemediation) {
  toast.add({
    title: t(`storage.anomalies.outcome.${result.outcome}`),
    description: result.outcome === 'failed' ? result.error : undefined,
    type: OUTCOME_TOAST_TYPE[OUTCOME_TONE[result.outcome]],
  })
}

/**
 * The System tab's storage dashboard: usage totals, the largest sessions,
 * the open anomalies the reconciliation job has found, and the actions that
 * act on them — everything else here is read-only until one of those is
 * explicitly clicked (and, for anything destructive, confirmed).
 */
export function StoragePage() {
  const { t } = useTranslation()
  const summary = useStorageSummary()
  const check = useRunStorageCheck()
  const cleanup = useRunStorageCleanup()
  const resolve = useResolveAnomaly()
  const bulkResolve = useBulkResolveAnomalies()
  const deleteAnomaly = useDeleteAnomaly()
  const recheckAnomaly = useRecheckAnomaly()
  const bulkDeleteAnomalies = useBulkDeleteAnomalies()

  const [view, setView] = useState<View>('open')
  const [classFilter, setClassFilter] = useState<AnomalyClass | ''>('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [pendingResolve, setPendingResolve] = useState<StorageAnomaly | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StorageAnomaly | null>(null)
  const [confirmResolveSelected, setConfirmResolveSelected] = useState(false)
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false)
  const [confirmCleanup, setConfirmCleanup] = useState(false)

  const anomalies = useStorageAnomalies({
    class: classFilter || undefined,
    resolved: view === 'resolved' ? 'true' : 'false',
  })

  // Unfiltered and always the *open* view, independent of whatever the table
  // above is currently filtered to — the per-class counters and the cleanup
  // confirmation's exact figures must never be quietly wrong because of a
  // filter the reader forgot they had set.
  const openAll = useStorageAnomalies({ resolved: 'false' })

  const perClass = useMemo(() => {
    const counts: Record<AnomalyClass, number> = {
      orphan_blob: 0,
      dangling_row: 0,
      orphan_session_dir: 0,
      checksum_mismatch: 0,
      orphan_idea_dir: 0,
      idea_dangling_row: 0,
      idea_checksum_mismatch: 0,
    }
    for (const a of openAll.data ?? []) counts[a.class] += 1
    return counts
  }, [openAll.data])

  // What `/storage/cleanup` would actually do — see cleanup-plan.ts for why
  // this is a named function rather than inline arithmetic here.
  const cleanupPlan = useMemo(() => cleanupPlanFor(openAll.data ?? []), [openAll.data])

  const columns = useMemo(
    () => [
      // Only the open view offers anything to select: a resolved row has no
      // destructive or dismissive action left to batch (see the actions
      // column below), and the two bulk buttons only render for this view.
      ...(view === 'open'
        ? [
            columnHelper.display({
              id: 'select',
              header: () => '',
              meta: { role: 'meta' },
              cell: (info) => (
                <Checkbox
                  aria-label={t('storage.anomalies.select')}
                  checked={info.row.getIsSelected()}
                  onCheckedChange={(checked) => info.row.toggleSelected(checked === true)}
                />
              ),
            }),
          ]
        : []),
      columnHelper.accessor('class', {
        header: () => t('storage.anomalies.table.class'),
        meta: { role: 'primary' },
        cell: (info) => (
          <StatusBadge tone={ANOMALY_TONE[info.getValue()]}>
            {t(`storage.classes.${info.getValue()}`)}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor('sessionId', {
        header: () => t('storage.anomalies.table.session'),
        meta: { role: 'secondary', label: t('storage.anomalies.table.session') },
        cell: (info) => <SessionRef sessionId={info.getValue()} />,
      }),
      columnHelper.accessor('originalFilename', {
        header: () => t('storage.anomalies.table.filename'),
        meta: { role: 'secondary', label: t('storage.anomalies.table.filename') },
        cell: (info) => info.getValue() ?? '—',
      }),
      columnHelper.accessor('path', {
        header: () => t('storage.anomalies.table.path'),
        meta: { role: 'secondary', label: t('storage.anomalies.table.path') },
        cell: (info) => {
          const value = info.getValue()
          return value ? <Code wrap>{value}</Code> : '—'
        },
      }),
      columnHelper.accessor('sizeBytes', {
        header: ({ column }) => (
          <SortableHeader label={t('storage.anomalies.table.size')} column={column} />
        ),
        meta: { role: 'meta', label: t('storage.anomalies.table.size') },
        cell: (info) => {
          const value = info.getValue()
          return value != null ? formatBytes(value) : '—'
        },
      }),
      columnHelper.accessor('firstSeenAt', {
        header: ({ column }) => (
          <SortableHeader label={t('storage.anomalies.table.firstSeen')} column={column} />
        ),
        meta: { role: 'meta', label: t('storage.anomalies.table.firstSeen') },
        cell: (info) => formatDateTime(info.getValue()) ?? '—',
      }),
      columnHelper.accessor('lastSeenAt', {
        header: () => t('storage.anomalies.table.lastSeen'),
        meta: { role: 'meta', label: t('storage.anomalies.table.lastSeen') },
        enableSorting: false,
        cell: (info) => formatDateTime(info.getValue()) ?? '—',
      }),
      columnHelper.display({
        id: 'actions',
        header: () => '',
        meta: { role: 'actions' },
        cell: (info) => {
          const anomaly = info.row.original
          const actions: MenuAction[] = anomaly.resolvedAt
            ? []
            : [
                {
                  id: 'recheck',
                  label: t('storage.anomalies.recheck'),
                  onSelect: () => {
                    recheckAnomaly.mutate(
                      { path: { id: anomaly.id } },
                      {
                        onSuccess: (result) => reportOutcome(t, result),
                        onError: (e) =>
                          toast.add({
                            title: apiErrorMessage(e, t('storage.anomalies.recheckFailed')),
                            type: 'error',
                          }),
                      },
                    )
                  },
                },
                {
                  id: 'resolve',
                  label: t('storage.anomalies.resolve'),
                  onSelect: () => setPendingResolve(anomaly),
                },
                {
                  id: 'delete',
                  label: t('storage.anomalies.delete'),
                  destructive: true,
                  onSelect: () => setPendingDelete(anomaly),
                },
              ]
          return <ActionsMenu actions={actions} label={t('storage.anomalies.actionsFor')} />
        },
      }),
    ],
    [t, view, recheckAnomaly],
  )

  const table = useReactTable({
    data: anomalies.data ?? [],
    columns,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const selectedIds = table.getSelectedRowModel().rows.map((row) => row.original.id)

  const topSessionsColumns = useMemo(
    () => [
      topSessionsColumnHelper.accessor('sessionId', {
        header: () => t('storage.topSessions.session'),
        meta: { role: 'primary' },
        cell: (info) => <SessionRef sessionId={info.getValue()} />,
      }),
      topSessionsColumnHelper.accessor('sizeBytes', {
        header: () => t('storage.topSessions.size'),
        meta: { role: 'meta', label: t('storage.topSessions.size') },
        cell: (info) => formatBytes(info.getValue()),
      }),
      topSessionsColumnHelper.accessor('fileCount', {
        header: () => t('storage.topSessions.files'),
        meta: { role: 'meta', label: t('storage.topSessions.files') },
        cell: (info) => info.getValue(),
      }),
    ],
    [t],
  )

  const topSessionsTable = useReactTable({
    data: summary.data?.topSessions ?? [],
    columns: topSessionsColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  const classOptions: { value: AnomalyClass | ''; label: string }[] = [
    { value: '', label: t('storage.anomalies.allClasses') },
    ...ANOMALY_CLASSES.map((cls) => ({ value: cls, label: t(`storage.classes.${cls}`) })),
  ]

  const runCheck = () =>
    check.mutate(undefined, { onSuccess: () => summary.startWatching('check') })
  const checking = check.isPending || summary.watching

  // Selection only ever means something against the open view's own rows —
  // switching what the reader is looking at should not leave a stale batch
  // armed against rows they can no longer see.
  const changeView = (next: View) => {
    setRowSelection({})
    setView(next)
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('storage.heading')} description={t('storage.lead')} />

      {summary.isError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {apiErrorMessage(summary.error, t('storage.loadFailed'))}
          </AlertDescription>
        </Alert>
      )}
      {!summary.isError && summary.isPending && <Loading label={t('common.loading')} block />}
      {!summary.isError && summary.data && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">{t('storage.summary.heading')}</h3>
            <DefinitionList
              items={[
                {
                  id: 'totalFiles',
                  term: t('storage.summary.totalFiles'),
                  description: summary.data.totalFiles,
                },
                {
                  id: 'totalBytes',
                  term: t('storage.summary.totalBytes'),
                  description: `${formatBytes(summary.data.totalBytes)} / ${formatBytes(summary.data.maxTotalBytes)}`,
                },
                {
                  id: 'sessionCount',
                  term: t('storage.summary.sessionCount'),
                  description: summary.data.sessionCount,
                },
                {
                  id: 'openAnomalies',
                  term: t('storage.summary.openAnomalies'),
                  description: summary.data.openAnomalies,
                },
                ...ANOMALY_CLASSES.map((cls) => ({
                  id: `class-${cls}`,
                  term: t(`storage.classes.${cls}`),
                  description: perClass[cls],
                })),
                {
                  id: 'lastCheck',
                  term: t('storage.summary.lastCheck'),
                  description:
                    formatDateTime(summary.data.lastCheckAt) ?? t('storage.summary.never'),
                },
                {
                  id: 'lastCleanup',
                  term: t('storage.summary.lastCleanup'),
                  description:
                    formatDateTime(summary.data.lastCleanupAt) ?? t('storage.summary.never'),
                },
                {
                  id: 'nextCheck',
                  term: t('storage.summary.nextCheck'),
                  description:
                    formatDateTime(summary.data.nextCheckAt) ?? t('storage.summary.notScheduled'),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {!summary.isError && summary.data && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">{t('storage.topSessions.heading')}</h3>
            {summary.data.topSessions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('storage.topSessions.empty')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <DataTable table={topSessionsTable} />
            )}
          </CardContent>
        </Card>
      )}

      {summary.data && !summary.data.lastCheckAt && (
        <Alert role="status">
          <TriangleAlertIcon />
          <AlertDescription>{t('storage.noCheckYet')}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" disabled={checking} onClick={runCheck}>
              {checking && <Spinner data-icon="inline-start" />}
              {checking ? t('storage.checking') : t('storage.runCheck')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmCleanup(true)}
              disabled={!summary.data?.lastCheckAt || openAll.isError}
            >
              {t('storage.cleanupEverything')}
            </Button>
          </div>
          {check.isError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(check.error, t('storage.checkFailed'))}
              </AlertDescription>
            </Alert>
          )}
          {cleanup.isError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(cleanup.error, t('storage.cleanupFailed'))}
              </AlertDescription>
            </Alert>
          )}
          {openAll.isError && (
            <Alert role="status">
              <TriangleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(openAll.error, t('storage.cleanupCountsFailed'))}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <PageHeader level={2} title={t('storage.anomalies.heading')} />

        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            aria-label={t('storage.anomalies.viewLabel')}
            variant="outline"
            value={[view]}
            onValueChange={(next) => {
              // Base UI represents a single-select group as a 0-or-1-length
              // array; a click on the already-pressed item reports the empty
              // one, which must leave `view` exactly where it was rather than
              // land on neither tab pressed.
              const value = next[0]
              if (value === 'open' || value === 'resolved') changeView(value)
            }}
          >
            <ToggleGroupItem value="open">{t('storage.anomalies.view.open')}</ToggleGroupItem>
            <ToggleGroupItem value="resolved">
              {t('storage.anomalies.view.resolved')}
            </ToggleGroupItem>
          </ToggleGroup>
          <Select
            items={classOptions}
            value={classFilter}
            onValueChange={(v) => setClassFilter((v as AnomalyClass | '') || '')}
          >
            <SelectTrigger className="w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {classOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view === 'open' && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selectedIds.length === 0}
                onClick={() => setConfirmResolveSelected(true)}
              >
                {t('storage.anomalies.resolveSelected')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={selectedIds.length === 0}
                onClick={() => setConfirmDeleteSelected(true)}
              >
                {t('storage.anomalies.deleteSelected')}
              </Button>
            </>
          )}
        </div>

        {anomalies.isError && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {apiErrorMessage(anomalies.error, t('storage.anomalies.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {!anomalies.isError && anomalies.isPending && <Loading label={t('common.loading')} block />}
        {!anomalies.isError && !anomalies.isPending && (
          <DataTable
            table={table}
            empty={
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('storage.anomalies.empty')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingResolve !== null}
        onOpenChange={(open) => !open && setPendingResolve(null)}
        title={t('storage.anomalies.resolveConfirm.title')}
        description={t('storage.anomalies.resolveConfirm.body')}
        destructive={false}
        confirmLabel={t('storage.anomalies.resolve')}
        busy={resolve.isPending}
        onConfirm={() => {
          if (!pendingResolve) return
          resolve.mutate(
            { path: { id: pendingResolve.id }, body: undefined },
            { onSettled: () => setPendingResolve(null) },
          )
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('storage.anomalies.deleteConfirm.title')}
        description={t('storage.anomalies.deleteConfirm.body')}
        confirmLabel={t('storage.anomalies.delete')}
        busy={deleteAnomaly.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          deleteAnomaly.mutate(
            { path: { id: pendingDelete.id } },
            {
              onSuccess: (result) => reportOutcome(t, result),
              onError: (e) =>
                toast.add({
                  title: apiErrorMessage(e, t('storage.anomalies.deleteFailed')),
                  type: 'error',
                }),
              onSettled: () => setPendingDelete(null),
            },
          )
        }}
      />

      <ConfirmDialog
        open={confirmResolveSelected}
        onOpenChange={setConfirmResolveSelected}
        title={t('storage.anomalies.resolveSelectedConfirm.title')}
        description={t('storage.anomalies.resolveSelectedConfirm.body', {
          count: selectedIds.length,
        })}
        destructive={false}
        confirmLabel={t('storage.anomalies.resolveSelected')}
        busy={bulkResolve.isPending}
        onConfirm={() => {
          bulkResolve.mutate(
            { body: { ids: selectedIds } },
            {
              onSuccess: () => setRowSelection({}),
              onError: (e) =>
                toast.add({
                  title: apiErrorMessage(e, t('storage.anomalies.resolveSelectedFailed')),
                  type: 'error',
                }),
              onSettled: () => setConfirmResolveSelected(false),
            },
          )
        }}
      />

      <ConfirmDialog
        open={confirmDeleteSelected}
        onOpenChange={setConfirmDeleteSelected}
        title={t('storage.anomalies.deleteSelectedConfirm.title')}
        description={t('storage.anomalies.deleteSelectedConfirm.body', {
          count: selectedIds.length,
        })}
        confirmLabel={t('storage.anomalies.deleteSelected')}
        busy={bulkDeleteAnomalies.isPending}
        onConfirm={() => {
          bulkDeleteAnomalies.mutate(
            { body: { ids: selectedIds } },
            {
              onSuccess: (data) => {
                const tally = tallyOutcomes(data.results)
                const parts = (['deleted', 'revalidated', 'unchanged', 'failed'] as const)
                  .filter((outcome) => tally[outcome] > 0)
                  .map(
                    (outcome) =>
                      `${tally[outcome]} ${t(`storage.anomalies.outcomeShort.${outcome}`)}`,
                  )
                toast.add({
                  title: t('storage.anomalies.deleteSelectedResultTitle'),
                  description: parts.join(' · '),
                  type: tally.failed > 0 ? 'error' : 'success',
                })
                setRowSelection({})
              },
              onError: (e) =>
                toast.add({
                  title: apiErrorMessage(e, t('storage.anomalies.deleteSelectedFailed')),
                  type: 'error',
                }),
              onSettled: () => setConfirmDeleteSelected(false),
            },
          )
        }}
      />

      <ConfirmDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title={t('storage.cleanupConfirm.title')}
        description={
          cleanupPlan.total === 0
            ? t('storage.cleanupConfirm.empty')
            : t('storage.cleanupConfirm.body', {
                blobs: cleanupPlan.blobs,
                rows: cleanupPlan.rows,
                dirs: cleanupPlan.dirs,
                mismatches: cleanupPlan.mismatches,
                bytes: formatBytes(cleanupPlan.bytes),
              })
        }
        confirmLabel={t('storage.cleanupEverything')}
        busy={cleanup.isPending}
        onConfirm={() => {
          cleanup.mutate(undefined, {
            onSuccess: () => summary.startWatching('cleanup'),
            onSettled: () => setConfirmCleanup(false),
          })
        }}
      />
    </div>
  )
}
