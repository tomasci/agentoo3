import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ConfirmDialog, Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import {
  type LibrarySuggestionSummary,
  useRejectSuggestion,
  useSuggestions,
} from '../hooks/use-learning'
import { LearningPanel } from './learning-panel'
import { LibraryTabs } from './library-tabs'
import { SuggestionCard } from './suggestion-card'

/**
 * `/library/suggested`: the learning panel, then every pending suggestion
 * split by what it does — a change to something that already exists, or a
 * brand-new agent/skill — rather than one mixed list, since the two call for
 * different review (a diff vs. a full preview, see the review page).
 */
export function SuggestedPage() {
  const { t } = useTranslation()
  const suggestions = useSuggestions('pending')
  const reject = useRejectSuggestion()
  const [pendingReject, setPendingReject] = useState<LibrarySuggestionSummary | null>(null)

  const { modify, create } = useMemo(() => {
    const list = suggestions.data ?? []
    return {
      modify: list.filter((s) => s.action === 'modify'),
      create: list.filter((s) => s.action === 'create'),
    }
  }, [suggestions.data])

  return (
    <div className="flex flex-col gap-8">
      <LibraryTabs />
      <LearningPanel />

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
        <>
          <div className="flex flex-col gap-3">
            <PageHeader level={2} title={t('library.suggestions.modifyHeading')} />
            {modify.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('library.suggestions.noModify')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-3">
                {modify.map((s) => (
                  <SuggestionCard key={s.id} suggestion={s} onReject={setPendingReject} />
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <PageHeader level={2} title={t('library.suggestions.createHeading')} />
            {create.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('library.suggestions.noCreate')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-3">
                {create.map((s) => (
                  <SuggestionCard key={s.id} suggestion={s} onReject={setPendingReject} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingReject !== null}
        onOpenChange={(open) => !open && setPendingReject(null)}
        title={t('library.suggestions.rejectTitle')}
        description={t('library.suggestions.rejectConfirm', { title: pendingReject?.title })}
        confirmLabel={t('library.suggestions.reject')}
        busy={reject.isPending}
        onConfirm={() => {
          if (!pendingReject) return
          reject.mutate(
            { path: { id: pendingReject.id } },
            { onSettled: () => setPendingReject(null) },
          )
        }}
      />
    </div>
  )
}
