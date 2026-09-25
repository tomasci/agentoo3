import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, type DefinitionItem, DefinitionList } from '@/shared/components'
import { parseNumberInput } from '@/shared/lib/number-input'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible'
import { Field, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Item, ItemContent } from '@/shared/ui/item'
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

export interface StartOptions {
  containerPort?: number
  hostPort?: number
}

interface ServiceListProps {
  projectId: string
  /** The scope this list's containers belong to — threaded down to each
   *  container's own log stream (`ContainerPanel` below), never read here
   *  otherwise: every mutation this row triggers is the caller's (see
   *  docker-page.tsx), already scoped there. */
  sessionId?: string
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
  sessionId,
  status,
  startDisabled,
  stopDisabled,
  onStart,
  onRestart,
  onStop,
}: ServiceListProps) {
  const rows = serviceRows(status)

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <ServiceRow
          key={row.service ?? '__app__'}
          projectId={projectId}
          sessionId={sessionId}
          row={row}
          status={status}
          startDisabled={startDisabled}
          stopDisabled={stopDisabled}
          onStart={onStart}
          onRestart={onRestart}
          onStop={onStop}
        />
      ))}
    </div>
  )
}

function ServiceRow({
  projectId,
  sessionId,
  row,
  status,
  startDisabled,
  stopDisabled,
  onStart,
  onRestart,
  onStop,
}: {
  projectId: string
  sessionId?: string
  row: ServiceRowModel
  status: DockerStatus
} & Pick<ServiceListProps, 'startDisabled' | 'stopDisabled' | 'onStart' | 'onRestart' | 'onStop'>) {
  const { t } = useTranslation()
  // Only the plain-Dockerfile row can hit this — a compose service's ports
  // are read straight off the compose file, never guessed.
  const needsPort = row.service === null && needsExplicitContainerPort(status)
  const [containerPort, setContainerPort] = useState<number | null>(3000)
  const [hostPort, setHostPort] = useState<number | null>(null)
  const containerPortId = useId()
  const hostPortId = useId()

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
    // A real `<article>` around `Card`: one service among several in a list
    // still earns its own landmark, the same idiom session-card.tsx and
    // idea-card.tsx use for their own rows.
    <article>
      <Card>
        <CardContent className="flex flex-col gap-3">
          {/* Stack below `sm` and pin to one row above it so card layout
              depends on the breakpoint, not on how long the service name is. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="truncate text-base font-semibold">{name}</h4>
              <span className="shrink-0">
                <ServiceStateBadge state={row.state} />
              </span>
            </div>
            <div className="flex flex-wrap gap-2 sm:shrink-0">
              <Button type="button" size="sm" disabled={!canStart} onClick={start}>
                {t('docker.actions.start')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canRestart}
                onClick={() => onRestart(services)}
              >
                {t('docker.actions.restart')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canStop}
                onClick={() => onStop(services)}
              >
                {t('docker.actions.stop')}
              </Button>
            </div>
          </div>

          {needsPort && !running && (
            <div className="flex flex-wrap items-start gap-3">
              <Field className="max-w-48">
                <FieldLabel htmlFor={containerPortId}>{t('docker.form.containerPort')}</FieldLabel>
                <Input
                  id={containerPortId}
                  type="number"
                  min={1}
                  max={65535}
                  value={containerPort ?? ''}
                  onChange={(e) => setContainerPort(parseNumberInput(e))}
                />
                <FieldDescription>{t('docker.form.containerPortHint')}</FieldDescription>
              </Field>
              <Field className="max-w-48">
                <FieldLabel htmlFor={hostPortId}>{t('docker.form.hostPort')}</FieldLabel>
                <Input
                  id={hostPortId}
                  type="number"
                  min={1024}
                  max={65535}
                  value={hostPort ?? ''}
                  onChange={(e) => setHostPort(parseNumberInput(e))}
                />
                <FieldDescription>{t('docker.form.hostPortHint')}</FieldDescription>
              </Field>
            </div>
          )}

          {declaredPorts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('docker.declaredPorts', { ports: declaredPorts.join(', ') })}
            </p>
          )}

          {row.containers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('docker.noContainerYet')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {row.containers.map((container) => (
                <ContainerPanel
                  key={container.id}
                  projectId={projectId}
                  sessionId={sessionId}
                  container={container}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </article>
  )
}

function ContainerPanel({
  projectId,
  sessionId,
  container,
}: {
  projectId: string
  sessionId?: string
  container: DockerContainer
}) {
  const { t } = useTranslation()
  const ports = container.ports.map(formatBoundPort)
  // Own state rather than trusting `Collapsible`'s unmount-on-close for the
  // gate that matters here: what keeps the log stream from starting until
  // the reader actually opens this panel is this boolean guarding
  // `{open && <ContainerLogs/>}` below, not whether `CollapsibleContent`
  // itself is in the DOM — the same 8-per-process cap this feature exists
  // not to hit.
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <Item variant="outline" size="sm">
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t(open ? 'docker.container.collapse' : 'docker.container.expand', {
                name: container.name,
              })}
            />
          }
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </CollapsibleTrigger>
        <ItemContent className="min-w-0 flex-row flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{container.name}</span>
          <ContainerStateBadge state={container.state} health={container.health} />
        </ItemContent>
        {ports.length > 0 && (
          <span className="text-xs text-muted-foreground">{ports.join(', ')}</span>
        )}
      </Item>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pt-2">
          <DefinitionList items={facts} />
          {open && (
            <ContainerLogs projectId={projectId} sessionId={sessionId} containerId={container.id} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
