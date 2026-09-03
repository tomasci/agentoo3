import { flexRender, type Table as TableInstance } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './data-table.module.scss'

interface DataTableProps<Row> {
  table: TableInstance<Row>
  /** Column ids that shrink to their content and right-align. */
  compactColumns?: readonly string[]
  /** Rendered instead of the body when the table has no rows. */
  empty?: ReactNode
}

/**
 * Wraps a `@tanstack/react-table` instance in the one markup + stylesheet
 * shared across every table, replacing two copies of both (30-line markup,
 * 60-line SCSS, each). The instance — columns, data, row model — stays the
 * caller's job; this only renders it.
 */
export function DataTable<Row>({
  table,
  compactColumns = ['actions'],
  empty,
}: DataTableProps<Row>) {
  const rows = table.getRowModel().rows
  const columnCount = table.getAllLeafColumns().length

  return (
    <div className={styles.root}>
      <table className={styles.table}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  className={cx(
                    styles.th,
                    compactColumns.includes(header.column.id) && styles.compact,
                  )}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td className={styles.empty} colSpan={columnCount}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className={styles.row}>
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cx(
                      styles.td,
                      compactColumns.includes(cell.column.id) && styles.compact,
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
