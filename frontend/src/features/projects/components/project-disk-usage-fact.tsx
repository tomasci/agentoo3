import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/features/system'
import { Loading } from '@/shared/components'
import { formatDateTime } from '@/shared/lib/date'
import { Button } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
import {
  useProjectDiskUsage,
  useRefetchDiskUsageOnStatusChange,
  useRefreshProjectDiskUsage,
} from '../hooks/use-disk-usage'
import { isInFlight, type Project } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'

/**
 * What the Settings page's "Size on disk" fact shows: the project folder's
 * total, how it splits between the checkout and the session worktrees, when
 * that was measured, and a way to measure again.
 *
 * Reads the single-project endpoint, not the list the picker's table uses —
 * this page is about one project and should not wait on, or poll, all of them.
 */
export function ProjectDiskUsageFact({ project }: { project: Project }) {
  const { t, i18n } = useTranslation()
  const query = useProjectDiskUsage(project.id)
  const refresh = useRefreshProjectDiskUsage(project.id)
  useRefetchDiskUsageOnStatusChange([project])

  // The folder is still being created; see `ProjectSizeCell`.
  if (isInFlight(project)) return <span>—</span>
  if (query.isPending) return <Loading label={t('common.loading')} />
  const usage = query.data
  if (!usage)
    return <p className="text-xs text-destructive">{t('projects.diskUsage.loadFailed')}</p>

  const measuringLabel = t('projects.diskUsage.measuring')
  const busy = usage.measuring || refresh.isPending

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {usage.totalBytes !== null ? (
          <span className="tabular-nums">{formatBytes(usage.totalBytes)}</span>
        ) : usage.measuring ? (
          <Loading label={measuringLabel} />
        ) : (
          <span>—</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => refresh.mutate({ path: { id: project.id } })}
        >
          {busy && <Spinner data-icon="inline-start" aria-label={measuringLabel} />}
          {t('projects.diskUsage.recalculate')}
        </Button>
      </div>
      {usage.repoBytes !== null && usage.worktreesBytes !== null && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('projects.diskUsage.breakdown', {
            repo: formatBytes(usage.repoBytes),
            worktrees: formatBytes(usage.worktreesBytes),
          })}
        </p>
      )}
      {usage.measuredAt && (
        <p className="text-xs text-muted-foreground">
          {t('projects.diskUsage.measuredAt', {
            when: formatDateTime(usage.measuredAt, i18n.resolvedLanguage),
          })}
        </p>
      )}
      {usage.error && (
        <p className="text-xs text-destructive">
          {t('projects.diskUsage.measureFailed', { reason: usage.error })}
        </p>
      )}
      {refresh.isError && (
        <p className="text-xs text-destructive">
          {apiErrorMessage(refresh.error, t('projects.diskUsage.refreshFailed'))}
        </p>
      )}
    </div>
  )
}
