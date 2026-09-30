import { CircleAlertIcon, InfoIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Code, Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Spinner } from '@/shared/ui/spinner'
import { useDockerSystemContainers } from '../hooks/use-docker-system'
import { formatUpdatedAt, sortSystemContainers } from '../lib/system'
import { DockerSystemTable } from './docker-system-table'

/**
 * The System tab's Docker page: every container on the host, across every
 * project, with a Stop button for the ones that are up — the host-wide
 * counterpart to `DockerPage` (docker-page.tsx), which only ever shows one
 * project's own containers.
 *
 * Polled every 5s, paused in the background, the same idiom
 * `SessionsDashboardPage` uses for its own always-open dashboard
 * (`useSessionsOverview`) — plus a manual Refresh button here, since a
 * container someone just stopped from a terminal is exactly the kind of
 * change worth not waiting out the interval for.
 */
export function DockerSystemPage() {
  const { t } = useTranslation()
  const containers = useDockerSystemContainers()

  const headerActions = (
    <div className="flex items-center gap-3">
      {containers.data && (
        <span className="text-xs text-muted-foreground">
          {t('docker.system.updatedAt', { time: formatUpdatedAt(containers.data.fetchedAt) })}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={containers.isFetching}
        onClick={() => void containers.refetch()}
      >
        {containers.isFetching ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RefreshCwIcon data-icon="inline-start" />
        )}
        {t('docker.system.refresh')}
      </Button>
    </div>
  )

  if (containers.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t('docker.system.heading')}
          description={t('docker.system.lead')}
          actions={headerActions}
        />
        <Loading label={t('common.loading')} block />
      </div>
    )
  }

  if (containers.isError || !containers.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t('docker.system.heading')}
          description={t('docker.system.lead')}
          actions={headerActions}
        />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {apiErrorMessage(containers.error, t('docker.system.loadFailed'))}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const data = containers.data
  const daemonReachable = data.daemon.cliInstalled && data.daemon.available
  const sorted = sortSystemContainers(data.containers)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('docker.system.heading')}
        description={t('docker.system.lead')}
        actions={headerActions}
      />

      {/* Reads still work with controls off (DOCKER_ENABLED=false) — the list
          above is never gated, only `POST .../stop` is (see the endpoint's
          own doc comment) — so this explains the one thing that changed
          rather than hiding the whole page behind it. */}
      {!data.enabled && (
        <Alert role="status">
          <InfoIcon />
          <AlertDescription>{t('docker.system.disabledNotice')}</AlertDescription>
        </Alert>
      )}

      {!daemonReachable && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {data.daemon.cliInstalled
              ? t('docker.system.daemon.unavailableTitle')
              : t('docker.system.daemon.notInstalledTitle')}
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <p>
                {data.daemon.cliInstalled
                  ? t('docker.system.daemon.unavailable')
                  : t('docker.system.daemon.notInstalled')}
              </p>
              {data.daemon.error && (
                <Code block wrap>
                  {data.daemon.error}
                </Code>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {sorted.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('docker.system.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('docker.system.empty.description')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DockerSystemTable containers={sorted} enabled={data.enabled} />
      )}
    </div>
  )
}
