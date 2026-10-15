import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/features/system'
import { Spinner } from '@/shared/ui/spinner'
import type { ProjectDiskUsage } from '../hooks/use-disk-usage'
import { isInFlight, type Project } from '../hooks/use-projects'

/** No figure, and `reason` (when there is one) on hover and for screen readers. */
function NoSize({ reason }: { reason?: string | null }) {
  if (!reason) return <span>—</span>
  return (
    <span role="img" aria-label={reason} title={reason}>
      —
    </span>
  )
}

/**
 * The projects table's "Size" cell: the project folder's total on disk.
 *
 * `usage` is `undefined` until the sizes list has answered (or when it has no
 * entry for this project yet), which is told apart from "the list failed to
 * load" by `loadFailed` — otherwise a failed request would leave a spinner
 * turning for good. A figure already on screen is never swapped for a spinner
 * while it is re-measured: the backend keeps serving the previous numbers
 * exactly so that nothing blinks out.
 */
export function ProjectSizeCell({
  project,
  usage,
  loadFailed,
}: {
  project: Project
  usage: ProjectDiskUsage | undefined
  loadFailed: boolean
}) {
  const { t } = useTranslation()
  const measuring = t('projects.diskUsage.measuring')

  // The folder is still being created, so there is nothing to measure — and
  // the backend's answer for it ("Project folder not found") is not news.
  if (isInFlight(project)) return <NoSize />

  if (!usage) {
    return loadFailed ? (
      <NoSize reason={t('projects.diskUsage.loadFailed')} />
    ) : (
      <Spinner aria-label={measuring} />
    )
  }

  if (usage.totalBytes !== null) {
    return (
      <span className="inline-flex h-5 items-center gap-1.5 tabular-nums">
        {formatBytes(usage.totalBytes)}
        {usage.measuring && <Spinner className="size-3" aria-label={measuring} />}
      </span>
    )
  }

  return usage.measuring ? <Spinner aria-label={measuring} /> : <NoSize reason={usage.error} />
}
