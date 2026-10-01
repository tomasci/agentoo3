import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { CircleAlertIcon, InfoIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { DataTable, Loading, PageHeader, SortableHeader } from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Input } from '@/shared/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'
import { type PortEntry, type PortScope, usePorts } from '../hooks/use-ports'
import { formatHostPort } from '../lib/format'

const columnHelper = createColumnHelper<PortEntry>()

// A stable reference for "no rows yet" (pending or errored, before any
// successful fetch) — a fresh `[]` literal on every render would give
// `useReactTable`'s `data` a new identity each time even though nothing
// meaningful changed, and its internal auto-reset-on-data-change plumbing
// (pagination, in particular) then keeps setting state in response, which
// keeps re-rendering this component, which creates another new `[]`: an
// infinite loop that only a stable identity here avoids.
const EMPTY_PORTS: PortEntry[] = []

/** Case-insensitive substring, across every field a reader would plausibly
 * search this table by — not just the two the brief names (port, process
 * name), since PID, the local address and the row's own attribution details
 * (its systemd unit, its Docker container, its owning user) are all free to
 * match too, and nothing about a global filter should surprise a reader by
 * ignoring what they typed matches. Deliberately over the row's own data
 * rather than a pre-filtered copy of it: TanStack's `globalFilter` state is
 * what drives the "Showing N of M" count below, and a second filtered array
 * here would just be a second source of truth for the same question.
 *
 * Takes the translated "unknown process" label rather than reading
 * `processName` straight off the row for an unresolved one: that raw value
 * is the literal `'unknown'`, but the Process Name column shows
 * `unknownProcessLabel` for that row (under ru, «неизвестно») — the filter
 * has to match what's on screen, not the English string underneath it. */
function createMatchesQuery(unknownProcessLabel: string) {
  return function matchesQuery(
    row: Row<PortEntry>,
    _columnId: string,
    filterValue: string,
  ): boolean {
    const query = filterValue.trim().toLowerCase()
    if (!query) return true
    const port = row.original
    const haystack = [
      String(port.localPort),
      port.processKnown ? port.processName : unknownProcessLabel,
      port.pid != null ? String(port.pid) : '',
      port.localAddress,
      port.unit ?? '',
      port.container ?? '',
      port.owner ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  }
}

/**
 * Builds the `pid` column's `sortingFn`, closed over the live `sorting`
 * state.
 *
 * `getSortedRowModel` (this app's pinned tanstack-table 8.9.9) flips
 * whatever a column's `sortingFn` returns when that column is currently
 * sorted `desc` — the same flip it applies to its own built-in
 * `sortUndefined` branch, which is why `sortUndefined: 'last'` (a later
 * version's fix for exactly this) is not available here, and a plain
 * ascending-sense comparator would put unresolved PIDs *first* on a `desc`
 * sort. Knowing the current direction and pre-inverting only the
 * unresolved-vs-resolved comparisons (never the resolved-vs-resolved ones,
 * which must still flip normally to produce a real descending order) is
 * what keeps "unknown always last" true in both directions.
 */
function pidSortingFn(sorting: SortingState) {
  return (rowA: Row<PortEntry>, rowB: Row<PortEntry>): number => {
    const a = rowA.getValue<number | null>('pid')
    const b = rowB.getValue<number | null>('pid')
    if (a == null && b == null) return 0
    if (a == null || b == null) {
      const desc = sorting.find((s) => s.id === 'pid')?.desc ?? false
      const cmp = a == null ? 1 : -1
      return desc ? -cmp : cmp
    }
    return a - b
  }
}

/**
 * The `processName` column's `sortingFn`, closed over the live `sorting`
 * state — the same technique as `pidSortingFn` above, and for the same
 * reason: a row with no known process (`processKnown: false`, the literal
 * string `'unknown'` underneath) must sort last in both directions rather
 * than first on `desc`, which is what a plain string comparator would do
 * with `'unknown'` sitting alphabetically among real names.
 */
function processNameSortingFn(sorting: SortingState) {
  return (rowA: Row<PortEntry>, rowB: Row<PortEntry>): number => {
    const a = rowA.original
    const b = rowB.original
    if (!a.processKnown && !b.processKnown) return 0
    if (!a.processKnown || !b.processKnown) {
      const desc = sorting.find((s) => s.id === 'processName')?.desc ?? false
      const cmp = !a.processKnown ? 1 : -1
      return desc ? -cmp : cmp
    }
    return a.processName.localeCompare(b.processName)
  }
}

/**
 * The Process Name cell's muted second line: the systemd unit or Docker
 * container behind an inferred name, the owning user, or both — mirroring
 * the Local Address column's own peer line.
 *
 * `docker` prefers `container` over `unit` (a container name is the more
 * useful fact for that row; `unit` there is always just `docker.service`),
 * everything else shows `unit` — which the backend fills whenever it knows
 * it, regardless of which attribution actually won, so even an exactly
 * `socket`-attributed row can carry one. `owner` appends after either with
 * ` · `, and stands alone when neither `unit` nor `container` is known: a
 * `none` row naming its owner (`root`) is more useful than a bare "unknown"
 * with nothing under it. Returns `null` — not rendered at all — only when
 * every one of those is unknown.
 */
function processAttributionSecondLine(port: PortEntry): string | null {
  const primary = port.attribution === 'docker' ? (port.container ?? port.unit) : port.unit
  if (primary && port.owner) return `${primary} · ${port.owner}`
  return primary ?? port.owner ?? null
}

/**
 * The System tab's live `ss -tulpn`: which process, if any, owns each socket
 * on the host, sortable, filterable, and refreshed on demand rather than
 * polled — see `usePorts`' own comment for why.
 */
export function PortsPage() {
  const { t, i18n } = useTranslation()
  const [scope, setScope] = useState<PortScope>('listening')
  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'port', desc: false }])

  const ports = usePorts(scope)

  // Rebuilt only when the unknown-process label itself changes (a
  // language switch), not on every render — see `createMatchesQuery`'s
  // own comment for why it needs that label at all.
  const globalFilterFn = useMemo(() => createMatchesQuery(t('ports.unknownProcess')), [t])

  const columns = useMemo(
    () => [
      columnHelper.accessor('protocol', {
        header: ({ column }) => (
          <SortableHeader label={t('ports.table.protocol')} column={column} />
        ),
        cell: (info) => <Badge variant="outline">{info.getValue().toUpperCase()}</Badge>,
      }),
      columnHelper.accessor('localAddress', {
        header: ({ column }) => (
          <SortableHeader label={t('ports.table.localAddress')} column={column} />
        ),
        cell: (info) => {
          const port = info.row.original
          return (
            <div className="flex flex-col">
              <span>{info.getValue()}</span>
              {port.peerAddress && (
                <span className="text-xs text-muted-foreground">
                  {t('ports.table.peer', {
                    hostPort: formatHostPort(port.peerAddress, port.peerPort),
                  })}
                </span>
              )}
            </div>
          )
        },
      }),
      columnHelper.accessor('localPort', {
        id: 'port',
        header: ({ column }) => <SortableHeader label={t('ports.table.port')} column={column} />,
        // `sortDescFirst: false`: tanstack-table's own default for a numeric
        // column is desc-first (`getAutoSortDir`), which — combined with this
        // table's own default sort starting at Port *ascending* — makes the
        // very first header click read as the *second* half of a cycle that
        // never had a first click, and it answers by clearing the sort
        // instead of reversing it. Pinning asc-first keeps a single click
        // doing the one thing a reader watching the arrow flip expects.
        sortDescFirst: false,
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor('pid', {
        header: ({ column }) => <SortableHeader label={t('ports.table.pid')} column={column} />,
        sortDescFirst: false,
        sortingFn: pidSortingFn(sorting),
        cell: (info) => info.getValue() ?? '—',
      }),
      columnHelper.accessor('processName', {
        header: ({ column }) => (
          <SortableHeader label={t('ports.table.processName')} column={column} />
        ),
        sortingFn: processNameSortingFn(sorting),
        cell: (info) => {
          const port = info.row.original
          // `processKnown` is false exactly when `attribution` is `'none'`
          // (the generated type's own doc comment on it), so a marker —
          // which only ever means `'service'` or `'docker'` — never has to
          // be considered for an unknown row.
          const inferred = port.attribution === 'service' || port.attribution === 'docker'
          const secondLine = processAttributionSecondLine(port)
          return (
            <div className="flex flex-col">
              {port.processKnown ? (
                inferred ? (
                  <span className="flex items-center gap-1">
                    {info.getValue()}
                    <Tooltip>
                      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a
                          read-only marker with nothing to activate — see
                          app/status-bar.tsx's `HostMetric` for the same
                          reason: Base UI opens a tooltip on trigger focus,
                          not on an unfocusable one made focusable for it.
                          The label itself sits on the icon below rather than
                          here: a bare span has no ARIA role of its own to
                          support `aria-label` on (it resolves to "generic"),
                          the same reason `ui/spinner.tsx` puts its own
                          `aria-label` on the icon rather than a wrapper. */}
                      <TooltipTrigger render={<span tabIndex={0} />}>
                        <InfoIcon
                          role="img"
                          aria-label={t('ports.attribution.label')}
                          className="size-3.5 text-muted-foreground"
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        {port.attribution === 'service'
                          ? t('ports.attribution.serviceTooltip', { unit: port.unit })
                          : t('ports.attribution.dockerTooltip', { container: port.container })}
                      </TooltipContent>
                    </Tooltip>
                  </span>
                ) : (
                  info.getValue()
                )
              ) : (
                <span className="text-muted-foreground">{t('ports.unknownProcess')}</span>
              )}
              {secondLine && <span className="text-xs text-muted-foreground">{secondLine}</span>}
            </div>
          )
        },
      }),
      columnHelper.accessor('state', {
        header: ({ column }) => <SortableHeader label={t('ports.table.state')} column={column} />,
        cell: (info) => info.getValue(),
      }),
    ],
    [t, sorting],
  )

  const table = useReactTable({
    data: ports.data?.ports ?? EMPTY_PORTS,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const totalRows = ports.data?.ports.length ?? 0
  const shownRows = table.getRowModel().rows.length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('ports.heading')}
        description={t('ports.lead')}
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={ports.isFetching}
            onClick={() => void ports.refetch()}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(ports.isFetching && 'animate-spin')}
            />
            {t('ports.refresh')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        {/* Always rendered, even in the no-data-yet and initial-error states
         * below: a scope this page is already showing (or about to retry) is
         * still a choice a reader can make before the first response ever
         * comes back — it must not wait on `ports.data` the way the filter
         * and count reasonably do. */}
        <ToggleGroup
          aria-label={t('ports.scope.label')}
          variant="outline"
          value={[scope]}
          onValueChange={(next) => {
            // Base UI reports a single-select group's click as a
            // 0-or-1-length array; a click on the already-pressed item
            // answers with the empty one, which must leave `scope`
            // exactly where it was rather than land on neither pressed.
            const value = next[0]
            if (value === 'listening' || value === 'all') setScope(value)
          }}
        >
          <ToggleGroupItem value="listening">{t('ports.scope.listening')}</ToggleGroupItem>
          <ToggleGroupItem value="all">{t('ports.scope.all')}</ToggleGroupItem>
        </ToggleGroup>
        {ports.data && (
          <>
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={t('ports.filter.placeholder')}
              aria-label={t('ports.filter.placeholder')}
              className="max-w-sm"
            />
            <span className="text-sm text-muted-foreground">
              {t('ports.count', { shown: shownRows, total: totalRows })}
            </span>
          </>
        )}
      </div>

      {ports.isError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{apiErrorMessage(ports.error, t('ports.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {ports.isPending && <Loading label={t('common.loading')} block />}

      {ports.data && (
        // `isPlaceholderData` (set by `usePorts`' own `keepPreviousData`):
        // while a scope switch is in flight this is still the *previous*
        // scope's answer, kept on screen instead of vanishing behind a
        // spinner — dimmed so it doesn't read as the new scope's own result,
        // with the Refresh button's existing spin (`ports.isFetching`)
        // already saying a request is in flight.
        <div
          className={cn('flex flex-col gap-6', ports.isPlaceholderData && 'opacity-60')}
          aria-busy={ports.isPlaceholderData || undefined}
        >
          {ports.data.truncated && (
            <Alert role="status">
              <TriangleAlertIcon />
              <AlertDescription>
                {t('ports.truncated', { shown: totalRows, total: ports.data.total })}
              </AlertDescription>
            </Alert>
          )}

          {((ports.data.inferredCount > 0 && !ports.data.runningAsRoot) ||
            ports.data.unattributedCount > 0) && (
            <Alert role="status">
              <InfoIcon />
              <AlertDescription>
                {/* `runningAsRoot`: as root the backend can read every fd
                    table directly, so nothing on this page is ever actually
                    inferred rather than read — the sentence naming that
                    trade-off would be describing a limit that does not
                    apply, even on the rare row still counted as `inferred`
                    (a docker-proxy match, say) rather than `socket`. */}
                {ports.data.inferredCount > 0 && !ports.data.runningAsRoot && (
                  <p>
                    {ports.data.user
                      ? t('ports.notice.inferredWithUser', {
                          count: ports.data.inferredCount,
                          user: ports.data.user,
                        })
                      : t('ports.notice.inferredWithoutUser', {
                          count: ports.data.inferredCount,
                        })}
                  </p>
                )}
                {ports.data.unattributedCount > 0 && (
                  <p>
                    {t('ports.notice.unattributed', {
                      count: ports.data.unattributedCount,
                      total: totalRows,
                    })}
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}

          {totalRows === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('ports.empty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <DataTable table={table} empty={<span>{t('ports.noMatch')}</span>} />
          )}

          <p className="text-xs text-muted-foreground">
            {t('ports.lastRefreshed', {
              time: new Date(ports.data.collectedAt).toLocaleTimeString(i18n.language),
              source: t(`ports.source.${ports.data.source}`),
            })}
          </p>
        </div>
      )}
    </div>
  )
}
