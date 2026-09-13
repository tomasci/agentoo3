import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmDialog,
  EmptyState,
  Inline,
  PageHeader,
  Spinner,
  Stack,
  toast,
} from '@/shared/ui'
import {
  useDockerDown,
  useDockerRestart,
  useDockerStatus,
  useDockerStop,
  useDockerUp,
} from '../hooks/use-docker'
import { hasDockerConfig, isOperationConflict } from '../lib/state'
import { AccessUrls } from './access-urls'
import styles from './docker-page.module.scss'
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
 */
export function DockerPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const status = useDockerStatus(projectId)
  const up = useDockerUp(projectId)
  const stop = useDockerStop(projectId)
  const restart = useDockerRestart(projectId)
  const down = useDockerDown(projectId)

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
    toast({
      title: isOperationConflict(error)
        ? t('docker.errors.operationInProgress')
        : apiErrorMessage(error, t(fallbackKey)),
      tone: 'danger',
    })

  const triggerUp = (services: string[], options?: StartOptions) =>
    up.mutate(
      {
        path: { id: projectId },
        body: { services: services.length ? services : undefined, ...options },
      },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.startFailed') },
    )
  const triggerStop = (services: string[]) =>
    stop.mutate(
      { path: { id: projectId }, body: services.length ? { services } : undefined },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.stopFailed') },
    )
  const triggerRestart = (services: string[]) =>
    restart.mutate(
      { path: { id: projectId }, body: services.length ? { services } : undefined },
      { onSuccess: (op) => setOperationId(op.id), onError: fail('docker.errors.restartFailed') },
    )
  const triggerCleanup = () =>
    down.mutate(
      // Stack-wide only (no per-service cleanup), and deliberately no
      // `removeVolumes`/`removeImages` — cleanup removes containers and the
      // compose-created network, never a volume or an image, unasked.
      { path: { id: projectId }, body: undefined },
      {
        onSuccess: (op) => setOperationId(op.id),
        onError: fail('docker.errors.cleanupFailed'),
        onSettled: () => setConfirmCleanup(false),
      },
    )

  if (status.isPending) return <Spinner label={t('common.loading')} block />
  if (status.isError || !status.data) {
    return <Alert>{apiErrorMessage(status.error, t('docker.loadFailed'))}</Alert>
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
    <Stack gap={6}>
      <PageHeader title={t('docker.heading')} description={t('docker.lead')} />

      {!configFound ? (
        <EmptyState
          title={t('docker.empty.title')}
          description={t('docker.empty.description', { path: data.projectPath })}
        />
      ) : (
        <>
          {!daemonReachable && (
            <Alert
              tone="danger"
              title={
                data.daemon.cliInstalled
                  ? t('docker.daemon.unavailableTitle')
                  : t('docker.daemon.notInstalledTitle')
              }
            >
              <Stack gap={2}>
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
              </Stack>
            </Alert>
          )}

          {data.configError && (
            <Alert
              tone="danger"
              title={t('docker.configErrorTitle', {
                file: data.detection.composeFile ?? t('docker.composeFileUnknown'),
              })}
            >
              <Code block wrap>
                {data.configError}
              </Code>
            </Alert>
          )}

          {data.foreignStacks.length > 0 && (
            <Alert tone="warning">
              {t('docker.foreignStacks', {
                names: data.foreignStacks.map((s) => s.name).join(', '),
              })}
            </Alert>
          )}

          <Card>
            <Stack gap={3}>
              <h3 className={styles.cardTitle}>{t('docker.stack.heading')}</h3>
              <Inline gap={2}>
                <Button
                  type="button"
                  loading={up.isPending}
                  disabled={startDisabled}
                  onClick={() => triggerUp([])}
                >
                  {t('docker.stack.startAll')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  loading={stop.isPending}
                  disabled={stopDisabled}
                  onClick={() => triggerStop([])}
                >
                  {t('docker.stack.stopAll')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  loading={restart.isPending}
                  disabled={startDisabled}
                  onClick={() => triggerRestart([])}
                >
                  {t('docker.stack.restart')}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  disabled={stopDisabled}
                  onClick={() => setConfirmCleanup(true)}
                >
                  {t('docker.stack.cleanup')}
                </Button>
              </Inline>
            </Stack>
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
    </Stack>
  )
}
