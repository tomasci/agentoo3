import type { GetApiDockerContainersStatus200 } from '@/shared/api/generated/types/GetApiDockerContainers'
import type { Tone } from '@/shared/components'

export type SystemContainer = GetApiDockerContainersStatus200['containers'][number]
export type SystemContainerOwner = NonNullable<SystemContainer['owner']>
export type SystemContainerState = SystemContainer['state']

/** The states Stop is offered for on the System tab's Docker page — a
 *  container has to actually be up, or on its way there or down, for
 *  stopping it to mean anything. `created`/`exited`/`dead`/`removing` get no
 *  button at all, not a disabled one. */
export const STOPPABLE_STATES: ReadonlySet<SystemContainerState> = new Set([
  'running',
  'restarting',
  'paused',
])

/**
 * Running containers first, then alphabetically by name — stable across
 * polls regardless of whatever order the daemon happens to answer in this
 * time (the endpoint's own name-ascending sort, GetApiDockerContainers's doc
 * comment, is a fine tiebreaker but not itself "running first").
 */
export function sortSystemContainers(containers: SystemContainer[]): SystemContainer[] {
  return [...containers].sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1
    if (a.state !== 'running' && b.state === 'running') return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Numbers only, comma-separated — `container.ports` is already a distinct,
 * ascending, address-free list of published host ports (see the endpoint's
 * own doc comment), so this only has to join it, never re-derive it. `'—'`
 * for none, the same literal every other empty table cell in this app uses
 * (e.g. storage-page.tsx, library-page.tsx) rather than a translated string.
 */
export function formatPorts(ports: number[]): string {
  return ports.length > 0 ? ports.join(', ') : '—'
}

/** `fetchedAt` as the reader's own locale time — the page header's "Updated …". */
export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString()
}

export interface ContainerStatusInfo {
  label: string
  tone: Tone
}

type T = (key: string, opts?: Record<string, unknown>) => string

/**
 * This page's own reading of the seven container states — coarser than
 * `docker/lib/state.ts`'s own `CONTAINER_STATE_TONE`: that one tones `dead`
 * as a failure (danger), but here it reads exactly like `exited`/`created` —
 * "Stopped", with the exit code if the daemon reported one — since a
 * system-wide list across every project is not the place to diagnose *why*
 * one project's container stopped, only that it did. Kept local rather than
 * changed there: the project Docker page still wants its own, more precise
 * reading of `dead`.
 *
 * `created` never shows an exit code even though the daemon reports one
 * (`0`) for it: the container has never run, so that `0` describes nothing
 * that happened — "Stopped" alone is the honest reading. `exited`/`dead`
 * have actually run and stopped, so their own exit code is worth showing.
 */
export function containerStatus(container: SystemContainer, t: T): ContainerStatusInfo {
  switch (container.state) {
    case 'running':
      return { label: t('docker.system.status.running'), tone: 'success' }
    case 'paused':
      return { label: t('docker.system.status.paused'), tone: 'warning' }
    case 'restarting':
      return { label: t('docker.system.status.restarting'), tone: 'warning' }
    case 'removing':
      return { label: t('docker.system.status.removing'), tone: 'warning' }
    case 'created':
      return { label: t('docker.system.status.stopped'), tone: 'neutral' }
    // 'exited' | 'dead'
    default:
      return {
        label:
          container.exitCode != null
            ? t('docker.system.status.stoppedWithCode', { code: container.exitCode })
            : t('docker.system.status.stopped'),
        tone: 'neutral',
      }
  }
}

/**
 * Whether the status cell's own health badge belongs next to
 * `containerStatus`'s badge. The daemon keeps reporting a container's last
 * `State.Health.Status` long after it stops — a container that has exited or
 * is still `created` can read `health: 'unhealthy'` or `'starting'` from
 * whatever check last ran while it was up, which would sit next to a
 * "Stopped" badge and read as if it were still checked. `container.health`
 * alone is never enough to decide the badge belongs on screen; it only does
 * while the container is actually `running`.
 */
export function showsHealth(container: SystemContainer): boolean {
  return container.state === 'running' && container.health !== 'none'
}
