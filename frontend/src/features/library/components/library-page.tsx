import { Link, useNavigate } from '@tanstack/react-router'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type Table as TableInstance,
  useReactTable,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, Button, ConfirmDialog, type MenuAction } from '@/shared/ui'
import {
  type AgentSummary,
  type Skill,
  useAgents,
  useDeleteAgent,
  useDeleteSkill,
  useSkills,
} from '../hooks/use-library'
import styles from './library.module.scss'

/** The two tables differ only in their columns, so the markup lives here once. */
function DataTable<Row>({ table }: { table: TableInstance<Row> }) {
  return (
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
  )
}

const agentColumn = createColumnHelper<AgentSummary>()
const skillColumn = createColumnHelper<Skill>()

export function LibraryPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const agents = useAgents()
  const skills = useSkills()
  const removeAgent = useDeleteAgent()
  const removeSkill = useDeleteSkill()

  // One piece of state per table: the row awaiting confirmation, or null.
  const [pendingAgent, setPendingAgent] = useState<AgentSummary | null>(null)
  const [pendingSkill, setPendingSkill] = useState<Skill | null>(null)

  const agentColumns = useMemo(
    () => [
      agentColumn.accessor('name', {
        header: () => t('library.table.name'),
        cell: (info) => (
          <Link
            to="/library/agents/$name"
            params={{ name: info.getValue() }}
            className={styles.nameLink}
          >
            {info.getValue()}
          </Link>
        ),
      }),
      agentColumn.accessor('role', {
        header: () => t('library.table.role'),
        cell: (info) => (
          <span
            className={`${styles.role} ${info.getValue() === 'orchestrator' ? styles.orchestrator : ''}`}
          >
            {t(`library.role.${info.getValue()}`)}
          </span>
        ),
      }),
      agentColumn.accessor('description', {
        header: () => t('library.table.description'),
        cell: (info) => <span className={styles.muted}>{info.getValue()}</span>,
      }),
      agentColumn.accessor('model', {
        header: () => t('library.table.model'),
        cell: (info) => <span className={styles.mono}>{info.getValue() ?? '—'}</span>,
      }),
      agentColumn.accessor('usedByProjects', {
        header: () => t('library.table.usedBy'),
        cell: (info) => (
          <span className={styles.muted}>
            {t('library.usedByCount', { count: info.getValue() })}
          </span>
        ),
      }),
      agentColumn.display({
        id: 'actions',
        header: () => '',
        cell: (info) => {
          const agent = info.row.original
          const actions: MenuAction[] = [
            {
              id: 'edit',
              label: t('common.edit'),
              onSelect: () =>
                void navigate({ to: '/library/agents/$name', params: { name: agent.name } }),
            },
            {
              id: 'delete',
              label: t('common.delete'),
              destructive: true,
              onSelect: () => setPendingAgent(agent),
            },
          ]
          return (
            <ActionsMenu actions={actions} label={t('library.actionsFor', { name: agent.name })} />
          )
        },
      }),
    ],
    [t, navigate],
  )

  const skillColumns = useMemo(
    () => [
      skillColumn.accessor('name', {
        header: () => t('library.table.name'),
        cell: (info) => (
          <Link
            to="/library/skills/$name"
            params={{ name: info.getValue() }}
            className={styles.nameLink}
          >
            {info.getValue()}
          </Link>
        ),
      }),
      skillColumn.accessor('description', {
        header: () => t('library.table.description'),
        cell: (info) => <span className={styles.muted}>{info.getValue()}</span>,
      }),
      skillColumn.accessor('extraFiles', {
        header: () => t('library.table.files'),
        cell: (info) => (
          <span className={styles.mono}>
            {info.getValue().length > 0
              ? t('library.bundledCount', { count: info.getValue().length })
              : '—'}
          </span>
        ),
      }),
      skillColumn.accessor('usedByProjects', {
        header: () => t('library.table.usedBy'),
        cell: (info) => (
          <span className={styles.muted}>
            {t('library.usedByCount', { count: info.getValue() })}
          </span>
        ),
      }),
      skillColumn.display({
        id: 'actions',
        header: () => '',
        cell: (info) => {
          const skill = info.row.original
          const actions: MenuAction[] = [
            {
              id: 'edit',
              label: t('common.edit'),
              onSelect: () =>
                void navigate({ to: '/library/skills/$name', params: { name: skill.name } }),
            },
            {
              id: 'delete',
              label: t('common.delete'),
              destructive: true,
              onSelect: () => setPendingSkill(skill),
            },
          ]
          return (
            <ActionsMenu actions={actions} label={t('library.actionsFor', { name: skill.name })} />
          )
        },
      }),
    ],
    [t, navigate],
  )

  const agentTable = useReactTable({
    data: agents.data ?? [],
    columns: agentColumns,
    getCoreRowModel: getCoreRowModel(),
  })
  const skillTable = useReactTable({
    data: skills.data ?? [],
    columns: skillColumns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('library.intro')}</p>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.title}>{t('library.agents')}</h2>
          <Link to="/library/agents/new">
            <Button type="button">{t('library.newAgent')}</Button>
          </Link>
        </div>

        {agents.isError && (
          <p className={styles.error}>{apiErrorMessage(agents.error, t('library.loadFailed'))}</p>
        )}
        {agents.isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!agents.isPending && (agents.data ?? []).length === 0 && (
          <p className={styles.empty}>{t('library.noAgents')}</p>
        )}
        {(agents.data ?? []).length > 0 && <DataTable table={agentTable} />}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.title}>{t('library.skills')}</h2>
          <Link to="/library/skills/new">
            <Button type="button">{t('library.newSkill')}</Button>
          </Link>
        </div>

        {skills.isError && (
          <p className={styles.error}>{apiErrorMessage(skills.error, t('library.loadFailed'))}</p>
        )}
        {skills.isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!skills.isPending && (skills.data ?? []).length === 0 && (
          <p className={styles.empty}>{t('library.noSkills')}</p>
        )}
        {(skills.data ?? []).length > 0 && <DataTable table={skillTable} />}
      </section>

      <ConfirmDialog
        open={pendingAgent !== null}
        onOpenChange={(open) => !open && setPendingAgent(null)}
        title={t('library.delete.agentTitle')}
        description={t('library.delete.agentConfirm', {
          name: pendingAgent?.name,
          count: pendingAgent?.usedByProjects ?? 0,
        })}
        busy={removeAgent.isPending}
        onConfirm={() => {
          if (!pendingAgent) return
          removeAgent.mutate(
            { path: { name: pendingAgent.name } },
            { onSettled: () => setPendingAgent(null) },
          )
        }}
      />

      <ConfirmDialog
        open={pendingSkill !== null}
        onOpenChange={(open) => !open && setPendingSkill(null)}
        title={t('library.delete.skillTitle')}
        description={t('library.delete.skillConfirm', {
          name: pendingSkill?.name,
          count: pendingSkill?.usedByProjects ?? 0,
          files: pendingSkill?.extraFiles.length ?? 0,
        })}
        busy={removeSkill.isPending}
        onConfirm={() => {
          if (!pendingSkill) return
          removeSkill.mutate(
            { path: { name: pendingSkill.name } },
            { onSettled: () => setPendingSkill(null) },
          )
        }}
      />
    </div>
  )
}
