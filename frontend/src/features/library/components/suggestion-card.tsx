import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { StatusBadge } from '@/shared/components'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import type { LibrarySuggestionSummary } from '../hooks/use-learning'
import { formatDateTime } from '../lib/format'

interface SuggestionCardProps {
  suggestion: LibrarySuggestionSummary
  onReject: (suggestion: LibrarySuggestionSummary) => void
}

/**
 * One row of the Suggested view's two lists — a card rather than a table:
 * the rationale is prose, not a value that fits a column, and clamping it
 * (`line-clamp-3`) only reads well with room to wrap.
 */
export function SuggestionCard({ suggestion, onReject }: SuggestionCardProps) {
  const { t } = useTranslation()
  const itemRoute = suggestion.kind === 'agent' ? '/library/agents/$name' : '/library/skills/$name'

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge tone={suggestion.kind === 'agent' ? 'accent' : 'neutral'}>
              {t(`library.suggestions.kind.${suggestion.kind}`)}
            </StatusBadge>
            {suggestion.action === 'modify' ? (
              <Link
                to={itemRoute}
                params={{ name: suggestion.name }}
                className="font-medium text-foreground hover:underline"
              >
                {suggestion.name}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{suggestion.name}</span>
            )}
            <span className="text-sm text-muted-foreground">{suggestion.title}</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {suggestion.action === 'modify' && suggestion.stale && (
              <StatusBadge tone="warning">{t('library.suggestions.stale')}</StatusBadge>
            )}
            {suggestion.action === 'modify' && !suggestion.targetExists && (
              <StatusBadge tone="danger">{t('library.suggestions.targetMissing')}</StatusBadge>
            )}
          </div>
        </div>

        <p className="line-clamp-3 text-sm text-muted-foreground">{suggestion.rationale}</p>

        {suggestion.sourceSessions.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">{t('library.suggestions.sourceSessions')}</span>
            {suggestion.sourceSessions.map((session) => (
              <Link
                key={session.id}
                to="/projects/$projectId/sessions/$sessionId"
                params={{ projectId: session.projectId, sessionId: session.id }}
                className="text-primary underline underline-offset-4 hover:no-underline"
              >
                {session.title ?? session.projectName}
              </Link>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t('library.suggestions.createdAt', { date: formatDateTime(suggestion.createdAt) })}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onReject(suggestion)}>
              {t('library.suggestions.reject')}
            </Button>
            <Link
              to="/library/suggestions/$id"
              params={{ id: suggestion.id }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('library.suggestions.review')}
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
