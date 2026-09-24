import { useTranslation } from 'react-i18next'
import { StatusBadge } from '@/shared/components'
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
    <StatusBadge tone="accent">
      {t(hasCompose ? 'docker.badge.compose' : 'docker.badge.dockerfile')}
    </StatusBadge>
  )
}

/** A compose service's real state — running/partial/stopped/absent. */
export function ServiceStateBadge({ state }: { state: ServiceState }) {
  const { t } = useTranslation()
  return (
    <StatusBadge tone={SERVICE_STATE_TONE[state]} pulse={state === 'running'}>
      {t(`docker.state.service.${state}`)}
    </StatusBadge>
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
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone={CONTAINER_STATE_TONE[state]} pulse={state === 'running'}>
        {t(`docker.state.container.${state}`)}
      </StatusBadge>
      {health !== 'none' && (
        <StatusBadge tone={CONTAINER_HEALTH_TONE[health]}>
          {t(`docker.state.health.${health}`)}
        </StatusBadge>
      )}
    </div>
  )
}
