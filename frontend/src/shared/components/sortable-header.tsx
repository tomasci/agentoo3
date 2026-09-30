import type { Column } from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'

/** A column header that also toggles that column's sort — `DataTable` itself
 * renders whatever a column's own `header` returns, so a clickable, stateful
 * header is a per-column concern, not something the shared table needs to
 * know about. Generic over `TData` so any feature's table can reuse this one
 * copy rather than keep its own (storage-page.tsx used to, before ports-page.tsx
 * needed the identical thing). */
export function SortableHeader<TData>({
  label,
  column,
}: {
  label: string
  column: Column<TData, unknown>
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
