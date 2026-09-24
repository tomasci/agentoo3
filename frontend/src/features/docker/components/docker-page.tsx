import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Code, ConfirmDialog, Loading, PageHeader, toast } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Spinner } from '@/shared/ui/spinner'
import {
  useDockerDown,
  useDockerRestart,
  useDockerStatus,
  useDockerStop,
  useDockerUp,
} from '../hooks/use-docker'
import { hasDockerConfig, isOperationConflict } from '../lib/state'
import { AccessUrls } from './access-urls'
import { DockerScopeBar } from './docker-scope-bar'
import { OperationConsole } from './operation-console'
import { ServiceList, type StartOptions } from './service-list'

/**
 * A project's Docker / Docker Compose dashboard: what was auto-detected,
 * start/restart/stop/cleanup per service and stack-wide, live logs, real
 * container state, and every URL a published port might be reached by.
 *
 * Always reachable from the project sidebar (sidebar.tsx's `nav.docker`
 * link never hides) — this page is what explains an unavailable state, not
 * the nav.
 *
 * `sessionId` scopes every request here to that session's own git worktree
 * instead of the project's repo/ checkout (backend/src/features/docker/scope.ts)
 * — omitted (the project-level `/docker` route, project-routes.tsx) means the
 * repo/ checkout, exactly like omitting the query param on the wire.
 * `DockerScopeBar` below is what a reader actually uses to tell the two apart
 * and move between them; this component only has to thread the id through.
 */
export function DockerPage({ projectId, sessionId }: { projectId: string; sessionId?: string }) {
  const { t } = useTranslation()
  const status = useDockerStatus(projectId, sessionId)
  const up = useDockerUp(projectId, sessionId)
  const stop = useDockerStop(projectId, sessionId)
  const restart = useDockerRestart(projectId, sessionId)
  const down = useDockerDown(projectId, sessionId)

  const [operationId, setOperationId] = useState<string | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)

  const serverActiveOperationId = status.data?.activeOperationId ?? null
  useEffect(() => {
    // Picks up an operation already running when the page loads — a reload
    // mid-`compose up`, or one started from another tab — but only ever
    // moves this forward. It is never cleared back to null on its own: the
    // console stays up showing the last operation's final output until the
    // reader dismisses it.
    if (serverActiveOperationId && serverActiveOperationId !== operationId) {
      setOperationId(serverActiveOperationId)
    }
  }, [serverActiveOperationId, operationId])

  const fail = (fallbackKey: string) => (error: unknown) =>
    toast.add({
      title: isOperationConflict(error)
        ? t('docker.errors.operationInProgress')
        : apiErrorMessage(error, t(fallbackKey)),
      type: 'error',
    })

  // Every mutation carries the same scope the status query above reads —
  // never separately decided, or a stack could be started in one scope and
  // the page could go on believing it belongs to the other.
  const scopeQuery = sessionId ? { sessionId } : undefined

  const triggerUp = (services: string[], options?: StartOptions) =>
    up.mutate(
      {
        path: { id: projectId },
        query: scopeQuery,
        body: { services: services.length ? services : undefined, ...options },
      },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.startFailed') },
    )
  const triggerStop = (services: string[]) =>
    stop.mutate(
      {
        path: { id: projectId },
        query: scopeQuery,
        body: services.length ? { services } : undefined,
      },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.stopFailed') },
    )
  const triggerRestart = (services: string[]) =>
    restart.mutate(
      {
        path: { id: projectId },
        query: scopeQuery,
        body: services.length ? { services } : undefined,
      },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.restartFailed') },
    )
  const triggerCleanup = () =>
    down.mutate(
      // Stack-wide only (no per-service cleanup), and deliberately no
      // `removeVolumes`/`removeImages` — cleanup removes containers and the
      // compose-created network, never a volume or an image, unasked.
      { path: { id: projectId }, query: scopeQuery, body: undefined },
      {
        onSuccess: (op) => setOperationId(op.id),
        onError: fail('docker.errors.cleanupFailed'),
        onSettled: () => setConfirmCleanup(false),
      },
    )

  // The scope bar renders through every state below, loading and error
  // included — a scope that 400s/404s/409s (an unknown session, one that
  // shares the project checkout, or a worktree that is no longer on disk;
  // see scope.ts) is exactly when a reader most needs the switcher to pick
  // a different one, not the moment to hide it.
  const scopeBar = <DockerScopeBar projectId={projectId} sessionId={sessionId} />

  if (status.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('docker.heading')} description={t('docker.lead')} />
        {scopeBar}
        <Loading label={t('common.loading')} block />
      </div>
    )
  }
  if (status.isError || !status.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('docker.heading')} description={t('docker.lead')} />
        {scopeBar}
        <Alert variant="destructive">
          <CircleAlertIcon />
          {sessionId && <AlertTitle>{t('docker.scope.errorTitle')}</AlertTitle>}
          <AlertDescription>
            {apiErrorMessage(status.error, t('docker.loadFailed'))}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const data = status.data
  const daemonReachable = data.daemon.cliInstalled && data.daemon.available
  const configFound = hasDockerConfig(data.detection)
  const opBusy =
    data.activeOperationId != null ||
    up.isPending ||
    stop.isPending ||
    restart.isPending ||
    down.isPending
  // Stop and cleanup stay usable through a broken compose file — a syntax
  // error must never strand a running container with no way to remove it.
  const startDisabled = !daemonReachable || data.configError != null || opBusy
  const stopDisabled = !daemonReachable || opBusy

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('docker.heading')} description={t('docker.lead')} />
      {scopeBar}

      {!configFound ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('docker.empty.title')}</EmptyTitle>
            {/* `scopePath`, not `projectPath`: at session scope this is the
                session's own worktree, and a fresh worktree holds only
                *tracked* files — a gitignored `.env` compose needs is not
                there yet, which is exactly what this path tells the reader to
                go create. */}
            <EmptyDescription>
              {t('docker.empty.description', { path: data.scopePath })}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {!daemonReachable && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>
                {data.daemon.cliInstalled
                  ? t('docker.daemon.unavailableTitle')
                  : t('docker.daemon.notInstalledTitle')}
              </AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  <p>
                    {data.daemon.cliInstalled
                      ? t('docker.daemon.unavailable')
                      : t('docker.daemon.notInstalled')}
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

          {data.configError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>
                {t('docker.configErrorTitle', {
                  file: data.detection.composeFile ?? t('docker.composeFileUnknown'),
                })}
              </AlertTitle>
              <AlertDescription>
                <Code block wrap>
                  {data.configError}
                </Code>
              </AlertDescription>
            </Alert>
          )}

          {data.foreignStacks.length > 0 && (
            <Alert role="status">
              <TriangleAlertIcon />
              <AlertDescription>
                {t('docker.foreignStacks', {
                  names: data.foreignStacks.map((s) => s.name).join(', '),
                })}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="flex flex-col gap-3">
              <h3 className="text-base font-semibold">{t('docker.stack.heading')}</h3>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={startDisabled || up.isPending}
                  onClick={() => triggerUp([])}
                >
                  {up.isPending && <Spinner data-icon="inline-start" />}
                  {t('docker.stack.startAll')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={stopDisabled || stop.isPending}
                  onClick={() => triggerStop([])}
                >
                  {stop.isPending && <Spinner data-icon="inline-start" />}
                  {t('docker.stack.stopAll')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={startDisabled || restart.isPending}
                  onClick={() => triggerRestart([])}
                >
                  {restart.isPending && <Spinner data-icon="inline-start" />}
                  {t('docker.stack.restart')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={stopDisabled}
                  onClick={() => setConfirmCleanup(true)}
                >
                  {t('docker.stack.cleanup')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {operationId && (
            <OperationConsole
              projectId={projectId}
              operationId={operationId}
              onDismiss={() => setOperationId(null)}
            />
          )}

          <AccessUrls hosts={data.hosts} containers={data.containers} />

          <ServiceList
            projectId={projectId}
            sessionId={sessionId}
            status={data}
            startDisabled={startDisabled}
            stopDisabled={stopDisabled}
            onStart={triggerUp}
            onRestart={triggerRestart}
            onStop={triggerStop}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title={t('docker.cleanupConfirm.title')}
        description={t('docker.cleanupConfirm.body')}
        confirmLabel={t('docker.stack.cleanup')}
        busy={down.isPending}
        onConfirm={triggerCleanup}
      />
    </div>
  )
}
