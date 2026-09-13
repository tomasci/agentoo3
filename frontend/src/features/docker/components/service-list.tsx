import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  Code,
  Collapsible,
  type DefinitionItem,
  DefinitionList,
  Field,
  Inline,
  NumberInput,
  Stack,
} from '@/shared/ui'
import {
  type DockerContainer,
  type DockerStatus,
  formatBoundPort,
  formatDeclaredComposePort,
  formatExposedPort,
  needsExplicitContainerPort,
  type ServiceRow as ServiceRowModel,
  serviceRows,
} from '../lib/state'
import { ContainerLogs } from './container-logs'
import { ContainerStateBadge, ServiceStateBadge } from './docker-badge'
import styles from './service-list.module.scss'

export interface StartOptions {
  containerPort?: number
  hostPort?: number
}

interface ServiceListProps {
  projectId: string
  status: DockerStatus
  /** Covers daemon unavailability, a busy project-wide operation, and (for
   * start/restart only) a broken compose file — see docker-page.tsx for how
   * each of those folds in. */
  startDisabled: boolean
  stopDisabled: boolean
  onStart: (services: string[], options?: StartOptions) => void
  onRestart: (services: string[]) => void
  onStop: (services: string[]) => void
}

/**
 * Every compose service, each with its own state, ports and containers — or,
 * for a plain-Dockerfile project, the one synthetic row standing in for its
 * single container (`serviceRows`, lib/state.ts, is what unifies the two
 * shapes into one list here).
 */
export function ServiceList({
  projectId,
  status,
  startDisabled,
  stopDisabled,
  onStart,
  onRestart,
  onStop,
}: ServiceListProps) {
  const rows = serviceRows(status)

  return (
    <Stack gap={3}>
      {rows.map((row) => (
        <ServiceRow
          key={row.service ?? '__app__'}
          projectId={projectId}
          row={row}
          status={status}
          startDisabled={startDisabled}
          stopDisabled={stopDisabled}
          onStart={onStart}
          onRestart={onRestart}
          onStop={onStop}
        />
      ))}
    </Stack>
  )
}

function ServiceRow({
  projectId,
  row,
  status,
  startDisabled,
  stopDisabled,
  onStart,
  onRestart,
  onStop,
}: {
  projectId: string
  row: ServiceRowModel
  status: DockerStatus
} & Pick<ServiceListProps, 'startDisabled' | 'stopDisabled' | 'onStart' | 'onRestart' | 'onStop'>) {
  const { t } = useTranslation()
  // Only the plain-Dockerfile row can hit this — a compose service's ports
  // are read straight off the compose file, never guessed.
  const needsPort = row.service === null && needsExplicitContainerPort(status)
  const [containerPort, setContainerPort] = useState<number | null>(3000)
  const [hostPort, setHostPort] = useState<number | null>(null)

  const running = row.state === 'running'
  const canStart = !running && !startDisabled && (!needsPort || containerPort != null)
  const canRestart = row.state !== 'absent' && !startDisabled
  const canStop = row.state !== 'absent' && !stopDisabled

  const services = row.service ? [row.service] : []
  const name = row.service ?? t('docker.appServiceName')

  const declaredPorts = row.service
    ? row.declaredPorts.map(formatDeclaredComposePort)
    : (status.image?.exposedPorts.length ? status.image.exposedPorts : status.dockerfilePorts).map(
        formatExposedPort,
      )

  const start = () =>
    onStart(
      services,
      needsPort
        ? { containerPort: containerPort ?? undefined, hostPort: hostPort ?? undefined }
        : undefined,
    )

  return (
    <Card>
      <Stack gap={3}>
        <Inline gap={3} justify="between" align="center" wrap>
          <Inline gap={2} align="center">
            <h4 className={styles.name}>{name}</h4>
            <ServiceStateBadge state={row.state} />
          </Inline>
          <Inline gap={2}>
            <Button type="button" size="sm" disabled={!canStart} onClick={start}>
              {t('docker.actions.start')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canRestart}
              onClick={() => onRestart(services)}
            >
              {t('docker.actions.restart')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canStop}
              onClick={() => onStop(services)}
            >
              {t('docker.actions.stop')}
            </Button>
          </Inline>
        </Inline>

        {needsPort && !running && (
          <Inline gap={3} align="start" wrap>
            <Field label={t('docker.form.containerPort')} hint={t('docker.form.containerPortHint')}>
              <NumberInput
                value={containerPort}
                onValueChange={setContainerPort}
                min={1}
                max={65535}
              />
            </Field>
            <Field label={t('docker.form.hostPort')} hint={t('docker.form.hostPortHint')}>
              <NumberInput value={hostPort} onValueChange={setHostPort} min={1024} max={65535} />
            </Field>
          </Inline>
        )}

        {declaredPorts.length > 0 && (
          <p className={styles.ports}>
            {t('docker.declaredPorts', { ports: declaredPorts.join(', ') })}
          </p>
        )}

        {row.containers.length === 0 ? (
          <p className={styles.muted}>{t('docker.noContainerYet')}</p>
        ) : (
          <Stack gap={2}>
            {row.containers.map((container) => (
              <ContainerPanel key={container.id} projectId={projectId} container={container} />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}

function ContainerPanel({
  projectId,
  container,
}: {
  projectId: string
  container: DockerContainer
}) {
  const { t } = useTranslation()
  const ports = container.ports.map(formatBoundPort)
  // Own state rather than trusting `Collapsible`'s `unmountOnExit`: Ark's
  // collapsible still mounts its content once to measure the height it
  // animates from, even when `defaultOpen` is false, so a log stream started
  // unconditionally inside `Collapsible`'s children would open for every
  // container the moment this page loads — exactly the 8-per-process cap
  // this feature exists not to hit. Gating the SSE hook itself on a plain
  // boolean this component owns is what actually keeps it closed until the
  // reader opens the panel.
  const [open, setOpen] = useState(false)

  const facts: DefinitionItem[] = [
    { id: 'id', term: t('docker.container.id'), description: <Code>{container.shortId}</Code> },
    {
      id: 'ports',
      term: t('docker.container.ports'),
      description: ports.length > 0 ? ports.join(', ') : t('docker.container.noPorts'),
    },
    ...(container.exitCode != null
      ? [{ id: 'exitCode', term: t('docker.container.exitCode'), description: container.exitCode }]
      : []),
  ]

  return (
    <div className={styles.container}>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        title={
          <Inline gap={2} align="center">
            <span>{container.name}</span>
            <ContainerStateBadge state={container.state} health={container.health} />
          </Inline>
        }
        meta={ports.length > 0 ? ports.join(', ') : undefined}
      >
        <Stack gap={3}>
          <DefinitionList items={facts} />
          {open && <ContainerLogs projectId={projectId} containerId={container.id} />}
        </Stack>
      </Collapsible>
    </div>
  )
}
