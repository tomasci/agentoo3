import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionsMenu, ConfirmDialog, type MenuAction } from '@/shared/ui'
import { type Project, useDeleteProject } from '../hooks/use-projects'
import { ProjectStatusBadge } from './project-status'
import styles from './projects-table.module.scss'

const columnHelper = createColumnHelper<Project>()

/**
 * The projects, with what state each is in and a way to open or remove it.
 *
 * Opening is handed out through `onOpen` rather than linked: a project opens
 * *into a tab*, and which tab that is — the empty one that asked, or the one it
 * is already open in — is the workspace's decision, not a table's.
 */
export function ProjectsTable({
  projects,
  onOpen,
}: {
  projects: Project[]
  onOpen: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const remove = useDeleteProject()
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('projects.table.name'),
        cell: (info) => {
          const project = info.row.original
          // Only a ready project has a checkout to open.
          return project.status === 'ready' ? (
            <button type="button" className={styles.nameLink} onClick={() => onOpen(project.id)}>
              {project.name}
            </button>
          ) : (
            <span className={`${styles.nameLink} ${styles.namePlain}`}>{project.name}</span>
          )
        },
      }),
      columnHelper.accessor('status', {
        header: () => t('projects.table.status'),
        cell: (info) => <ProjectStatusBadge project={info.row.original} />,
      }),
      columnHelper.accessor('path', {
        header: () => t('projects.table.path'),
        cell: (info) => <span className={styles.path}>{info.getValue()}</span>,
      }),
      columnHelper.display({
        id: 'actions',
        header: () => '',
        cell: (info) => {
          const project = info.row.original
          const actions: MenuAction[] = [
            {
              id: 'open',
              label: t('projects.open'),
              disabled: project.status !== 'ready',
              onSelect: () => onOpen(project.id),
            },
            {
              id: 'delete',
              label: t('common.delete'),
              destructive: true,
              onSelect: () => setPendingDelete(project),
            },
          ]
          return (
            <ActionsMenu
              actions={actions}
              label={t('projects.table.actionsFor', { name: project.name })}
            />
          )
        },
      }),
    ],
    [t, onOpen],
  )

  const table = useReactTable({ data: projects, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <>
      <div className={styles.wrapper}>
        <table className={styles.table}>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className={`${styles.th} ${header.id === 'actions' ? styles.actionsCell : ''}`}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className={styles.row}>
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`${styles.td} ${cell.column.id === 'actions' ? styles.actionsCell : ''}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('projects.delete.title')}
        description={
          pendingDelete?.source === 'clone'
            ? t('projects.delete.confirmClone', { name: pendingDelete?.name })
            : t('projects.delete.confirmExisting', { name: pendingDelete?.name })
        }
        busy={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(
            {
              path: { id: pendingDelete.id },
              query: { removeFiles: pendingDelete.source === 'clone' ? 'true' : 'false' },
            },
            { onSettled: () => setPendingDelete(null) },
          )
        }}
      />
    </>
  )
}
