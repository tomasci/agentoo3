import { flexRender, type RowData, type Table as TableInstance } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'

export type ColumnRole = 'primary' | 'secondary' | 'meta' | 'actions'

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** How this column reads. Unset gets neither the truncation nor the
     *  `title` attribute a 'secondary' column gets — the cell renders as-is. */
    role?: ColumnRole
    /** Accepted for compatibility with the pre-shadcn `DataTable`'s below-md
     *  card stacking; unused now that shadcn's table scrolls horizontally
     *  instead. A plain string — `header` is a render template and cannot be
     *  stringified, so this stayed a separate field rather than folding in. */
    label?: string
  }
}

const ROLE_CLASS: Partial<Record<ColumnRole, string>> = {
  // `w-full max-w-0` is the standard table-cell truncation trick: it tells the
  // browser's auto layout that this column contributes nothing to the table's
  // preferred width, so it only ever gets what's left after every other
  // column has taken its natural width, and `truncate` then ellipsizes
  // whatever doesn't fit — rather than the `whitespace-nowrap` every cell
  // inherits from `ui/table`'s `TableCell` running the text past the content
  // panel's edge. Gated to `lg:` so a narrower viewport keeps today's
  // fallback (the table's own `overflow-x-auto`) instead, which reads a long
  // value in full at a swipe rather than behind an ellipsis.
  secondary: 'lg:w-full lg:max-w-0 lg:truncate',
  meta: 'text-muted-foreground',
  actions: 'w-0 text-right',
}

interface DataTableProps<Row> {
  table: TableInstance<Row>
  /** Rendered instead of the body when the table has no rows. */
  empty?: ReactNode
}

/**
 * Wraps a `@tanstack/react-table` instance in shadcn's table parts — the
 * instance (columns, data, row model) stays the caller's job, this only
 * renders it.
 *
 * Below `md` this scrolls horizontally (`ui/table`'s own wrapper is
 * `overflow-x-auto`) rather than stacking into cards the way the Ark-based
 * version did — that hack existed to keep native table semantics working
 * once `display` was overridden to lay a row out as a card, and there is no
 * such override here.
 */
export function DataTable<Row>({ table, empty }: DataTableProps<Row>) {
  const rows = table.getRowModel().rows
  const columnCount = table.getAllLeafColumns().length

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const role = header.column.columnDef.meta?.role
              return (
                <TableHead key={header.id} className={role && ROLE_CLASS[role]}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length === 0 && empty ? (
          <TableRow>
            <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const role = cell.column.columnDef.meta?.role
                // A `secondary` cell can now be clipped by the `truncate` above —
                // its own `title` is the only way left to read the rest, and only
                // for a plain-string value: a rendered cell can be arbitrary JSX
                // (a badge, a link), and there's no reliable "text" to lift out
                // of that to put in an attribute.
                const value = cell.getValue()
                const title = role === 'secondary' && typeof value === 'string' ? value : undefined
                return (
                  <TableCell
                    key={cell.id}
                    role={role === 'primary' ? 'rowheader' : undefined}
                    className={role && ROLE_CLASS[role]}
                    title={title}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                )
              })}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
