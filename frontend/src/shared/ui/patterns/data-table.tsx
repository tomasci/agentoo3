import { flexRender, type RowData, type Table as TableInstance } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './data-table.module.scss'

export type ColumnRole = 'primary' | 'secondary' | 'meta' | 'actions'

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** How this column behaves when the table stacks. Default: 'secondary'. */
    role?: ColumnRole
    /** The stacked-mode label. A plain string — `header` is a render template
     *  and cannot be stringified, so this is declared separately. */
    label?: string
  }
}

// Below `md` (data-table.module.scss) a row folds into a card; a column's
// role decides how its cell sits in that card. `styles[x]` indexing is
// banned (component-contract.md) — this Record fails the build if a role is
// added without a class to go with it.
const ROLE: Record<ColumnRole, string> = {
  primary: styles.rolePrimary as string,
  secondary: styles.roleSecondary as string,
  meta: styles.roleMeta as string,
  actions: styles.roleActions as string,
}

interface DataTableProps<Row> {
  table: TableInstance<Row>
  /** Rendered instead of the body when the table has no rows. */
  empty?: ReactNode
}

/**
 * Wraps a `@tanstack/react-table` instance in the one markup + stylesheet
 * shared across every table, replacing two copies of both (30-line markup,
 * 60-line SCSS, each). The instance — columns, data, row model — stays the
 * caller's job; this only renders it.
 *
 * Below `md` the table becomes a column of cards, CSS-only, driven entirely
 * by each column's `meta.role`/`meta.label` — there is no separate mobile
 * markup. Overriding `display` this way strips `table`/`tr`/`td`'s native
 * table semantics in Chrome and Firefox, so the matching ARIA roles below
 * are load-bearing, not decorative, and are emitted in both modes.
 */
export function DataTable<Row>({ table, empty }: DataTableProps<Row>) {
  const rows = table.getRowModel().rows
  const columnCount = table.getAllLeafColumns().length

  return (
    <div className={styles.root}>
      {/* biome-ignore lint/a11y/noRedundantRoles: only redundant above `md` —
          `.table`/`.row` override `display` below it (data-table.module.scss)
          to stack the table into cards, which strips these implicit roles in
          Chrome and Firefox. Emitting them unconditionally is the fix. */}
      <table className={styles.table} role="table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            // biome-ignore lint/a11y/noRedundantRoles: see the `<table>` above.
            <tr key={group.id} role="row">
              {group.headers.map((header) => {
                const role = header.column.columnDef.meta?.role ?? 'secondary'
                return (
                  <th key={header.id} className={cx(styles.th, ROLE[role])}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            // biome-ignore lint/a11y/noRedundantRoles: see the `<table>` above.
            <tr role="row">
              {/* biome-ignore lint/a11y/noRedundantRoles: see the `<table>` above. */}
              <td className={styles.empty} colSpan={columnCount} role="cell">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              // biome-ignore lint/a11y/noRedundantRoles: see the `<table>` above.
              <tr key={row.id} className={styles.row} role="row">
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta
                  const role = meta?.role ?? 'secondary'
                  const label = meta?.label
                  return (
                    <td
                      key={cell.id}
                      className={cx(styles.td, ROLE[role])}
                      role={role === 'primary' ? 'rowheader' : 'cell'}
                    >
                      {typeof label === 'string' && label.length > 0 && (
                        <span className={styles.cellLabel} aria-hidden="true">
                          {label}
                        </span>
                      )}
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
