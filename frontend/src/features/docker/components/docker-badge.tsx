import { useTranslation } from 'react-i18next'
import { Badge, Inline, StatusDot } from '@/shared/ui'
import {
  CONTAINER_HEALTH_TONE,
  CONTAINER_STATE_TONE,
  type ContainerHealth,
  type ContainerState,
  SERVICE_STATE_TONE,
  type ServiceState,
} from '../lib/state'

/**
 * A small "Docker" indicator for a project row or fact — whether *any*
 * config was detected, independent of whether anything is currently running.
 * Used outside this feature (projects-table.tsx, project-overview.tsx),
 * which is why it takes plain booleans rather than a `DockerStatus`.
 */
export function DockerDetectedBadge({
  hasCompose,
  hasDockerfile,
}: {
  hasCompose: boolean
  hasDockerfile: boolean
}) {
  const { t } = useTranslation()
  if (!hasCompose && !hasDockerfile) return null
  return (
    <Badge tone="accent" variant="outline">
      {t(hasCompose ? 'docker.badge.compose' : 'docker.badge.dockerfile')}
    </Badge>
  )
}

/** A compose service's real state — running/partial/stopped/absent. */
export function ServiceStateBadge({ state }: { state: ServiceState }) {
  const { t } = useTranslation()
  return (
    <Inline gap={2} align="center">
      <StatusDot tone={SERVICE_STATE_TONE[state]} pulse={state === 'running'} />
      <Badge tone={SERVICE_STATE_TONE[state]}>{t(`docker.state.service.${state}`)}</Badge>
    </Inline>
  )
}

/** One container's real state, plus health when the image declares a
 * healthcheck — `none` is not worth a second badge next to the state one. */
export function ContainerStateBadge({
  state,
  health,
}: {
  state: ContainerState
  health: ContainerHealth
}) {
  const { t } = useTranslation()
  return (
    <Inline gap={2} align="center">
      <StatusDot tone={CONTAINER_STATE_TONE[state]} pulse={state === 'running'} />
      <Badge tone={CONTAINER_STATE_TONE[state]}>{t(`docker.state.container.${state}`)}</Badge>
      {health !== 'none' && (
        <Badge tone={CONTAINER_HEALTH_TONE[health]} variant="outline">
          {t(`docker.state.health.${health}`)}
        </Badge>
      )}
    </Inline>
  )
}
