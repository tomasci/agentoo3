import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Alert,
  Badge,
  Button,
  Code,
  ConfirmDialog,
  DataTable,
  EmptyState,
  type MenuAction,
  PageHeader,
  Spinner,
  Stack,
} from '@/shared/ui'
import {
  type AgentSummary,
  type Skill,
  useAgents,
  useDeleteAgent,
  useDeleteSkill,
  useSkills,
} from '../hooks/use-library'
import styles from './library.module.scss'

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
          <Badge tone={info.getValue() === 'orchestrator' ? 'accent' : 'neutral'} variant="outline">
            {t(`library.role.${info.getValue()}`)}
          </Badge>
        ),
      }),
      agentColumn.accessor('description', {
        header: () => t('library.table.description'),
        cell: (info) => <span className={styles.muted}>{info.getValue()}</span>,
      }),
      agentColumn.accessor('model', {
        header: () => t('library.table.model'),
        cell: (info) => <Code>{info.getValue() ?? '—'}</Code>,
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
          <Code>
            {info.getValue().length > 0
              ? t('library.bundledCount', { count: info.getValue().length })
              : '—'}
          </Code>
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
    <Stack gap={8}>
      <p className={styles.intro}>{t('library.intro')}</p>

      <Stack gap={3}>
        <PageHeader
          level={2}
          title={t('library.agents')}
          actions={
            <Link to="/library/agents/new">
              <Button type="button">{t('library.newAgent')}</Button>
            </Link>
          }
        />

        {agents.isError && <Alert>{apiErrorMessage(agents.error, t('library.loadFailed'))}</Alert>}
        {!agents.isError && agents.isPending && <Spinner label={t('common.loading')} block />}
        {!agents.isError && !agents.isPending && (
          <DataTable table={agentTable} empty={<EmptyState title={t('library.noAgents')} />} />
        )}
      </Stack>

      <Stack gap={3}>
        <PageHeader
          level={2}
          title={t('library.skills')}
          actions={
            <Link to="/library/skills/new">
              <Button type="button">{t('library.newSkill')}</Button>
            </Link>
          }
        />

        {skills.isError && <Alert>{apiErrorMessage(skills.error, t('library.loadFailed'))}</Alert>}
        {!skills.isError && skills.isPending && <Spinner label={t('common.loading')} block />}
        {!skills.isError && !skills.isPending && (
          <DataTable table={skillTable} empty={<EmptyState title={t('library.noSkills')} />} />
        )}
      </Stack>

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
    </Stack>
  )
}
