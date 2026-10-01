import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  ConfirmDialog,
  DataTable,
  Loading,
  type MenuAction,
  PageHeader,
  StatusBadge,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import {
  type LibrarySuggestionSummary,
  useDeleteSuggestion,
  useSuggestions,
} from '../hooks/use-learning'
import { formatDateTime } from '../lib/format'
import { LibraryTabs } from './library-tabs'

const column = createColumnHelper<LibrarySuggestionSummary>()

/**
 * `/library/rejected`: every suggestion the operator turned down, kept so the
 * learning job does not propose the same idea again until one is deleted
 * here — see `ConfirmDialog`'s own copy below for what deleting actually
 * means.
 */
export function RejectedPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const suggestions = useSuggestions('rejected')
  const remove = useDeleteSuggestion()
  const [pendingDelete, setPendingDelete] = useState<LibrarySuggestionSummary | null>(null)

  const columns = useMemo(
    () => [
      column.accessor('kind', {
        header: () => t('library.suggestions.table.kind'),
        meta: { role: 'meta', label: t('library.suggestions.table.kind') },
        cell: (info) => t(`library.suggestions.kind.${info.getValue()}`),
      }),
      column.accessor('action', {
        header: () => t('library.suggestions.table.action'),
        meta: { role: 'meta', label: t('library.suggestions.table.action') },
        cell: (info) => (
          <StatusBadge tone={info.getValue() === 'create' ? 'accent' : 'neutral'}>
            {t(`library.suggestions.action.${info.getValue()}`)}
          </StatusBadge>
        ),
      }),
      column.accessor('name', {
        header: () => t('library.table.name'),
        meta: { role: 'primary' },
        cell: (info) => (
          <Link
            to="/library/suggestions/$id"
            params={{ id: info.row.original.id }}
            className="font-medium text-foreground hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('title', {
        header: () => t('library.table.description'),
        meta: { role: 'secondary', label: t('library.table.description') },
        cell: (info) => <span className="text-sm text-muted-foreground">{info.getValue()}</span>,
      }),
      column.accessor('decidedAt', {
        header: () => t('library.suggestions.table.rejectedAt'),
        meta: { role: 'meta', label: t('library.suggestions.table.rejectedAt') },
        cell: (info) => formatDateTime(info.getValue()),
      }),
      column.display({
        id: 'actions',
        header: () => '',
        meta: { role: 'actions' },
        cell: (info) => {
          const suggestion = info.row.original
          const actions: MenuAction[] = [
            {
              id: 'view',
              label: t('library.suggestions.review'),
              onSelect: () =>
                void navigate({ to: '/library/suggestions/$id', params: { id: suggestion.id } }),
            },
            {
              id: 'delete',
              label: t('library.suggestions.deletePermanently'),
              destructive: true,
              onSelect: () => setPendingDelete(suggestion),
            },
          ]
          return (
            <ActionsMenu
              actions={actions}
              label={t('library.actionsFor', { name: suggestion.name })}
            />
          )
        },
      }),
    ],
    [t, navigate],
  )

  const table = useReactTable({
    data: suggestions.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="flex flex-col gap-8">
      <LibraryTabs />

      <div className="flex flex-col gap-3">
        <PageHeader
          title={t('library.suggestions.rejectedHeading')}
          description={t('library.suggestions.rejectedIntro')}
        />

        {suggestions.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(suggestions.error, t('library.suggestions.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {!suggestions.isError && suggestions.isPending && (
          <Loading label={t('common.loading')} block />
        )}
        {!suggestions.isError && !suggestions.isPending && (
          <DataTable
            table={table}
            empty={
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('library.suggestions.noRejected')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('library.suggestions.deleteTitle')}
        description={t('library.suggestions.deleteConfirm', { title: pendingDelete?.title })}
        confirmLabel={t('library.suggestions.deletePermanently')}
        busy={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(
            { path: { id: pendingDelete.id } },
            { onSettled: () => setPendingDelete(null) },
          )
        }}
      />
    </div>
  )
}
