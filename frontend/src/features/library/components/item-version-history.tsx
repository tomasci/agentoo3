import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loading, Markdown, StatusBadge } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { type LibraryItemVersion, useAgentVersions, useSkillVersions } from '../hooks/use-learning'
import { formatDateTime } from '../lib/format'

interface ItemVersionHistoryProps {
  kind: 'agent' | 'skill'
  name: string
}

/**
 * The agent/skill editor pages' own "History" section, edit mode only — a
 * new item has no versions to show yet, only its own hands-off creation. One
 * version is the file's own content at a point in time: either a `snapshot`
 * (the prior content, captured right before a suggestion was applied over
 * it) or `suggestion` (what that apply actually wrote) — see
 * `LibraryItemVersion`'s own doc comment.
 */
export function ItemVersionHistory({ kind, name }: ItemVersionHistoryProps) {
  const { t } = useTranslation()
  const agentVersions = useAgentVersions(kind === 'agent' ? name : '')
  const skillVersions = useSkillVersions(kind === 'skill' ? name : '')
  const query = kind === 'agent' ? agentVersions : skillVersions
  const [viewing, setViewing] = useState<LibraryItemVersion | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">{t('library.history.heading')}</h2>

      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t('library.history.loadFailed')}</AlertDescription>
        </Alert>
      )}
      {!query.isError && query.isPending && <Loading label={t('common.loading')} />}
      {!query.isError && !query.isPending && (query.data?.length ?? 0) === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('library.history.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {!query.isError && !query.isPending && query.data && query.data.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {query.data.map((version) => (
            <li
              key={version.version}
              className="flex flex-wrap items-center justify-between gap-2 p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {t('library.history.versionLabel', { version: version.version })}
                </span>
                <StatusBadge tone={version.source === 'suggestion' ? 'accent' : 'neutral'}>
                  {version.source === 'suggestion'
                    ? t('library.history.appliedSuggestion')
                    : t('library.history.snapshot')}
                </StatusBadge>
                <span className="text-muted-foreground">{formatDateTime(version.createdAt)}</span>
                {version.source === 'suggestion' && version.suggestionId && (
                  <Link
                    to="/library/suggestions/$id"
                    params={{ id: version.suggestionId }}
                    className="text-primary underline underline-offset-4 hover:no-underline"
                  >
                    {t('library.history.viewSuggestion')}
                  </Link>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setViewing(version)}>
                {t('library.history.view')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {viewing && t('library.history.versionLabel', { version: viewing.version })}
            </DialogTitle>
          </DialogHeader>
          {viewing && <Markdown>{viewing.markdown}</Markdown>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
