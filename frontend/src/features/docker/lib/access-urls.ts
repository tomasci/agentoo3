import type { DockerContainer } from './state'

export type ServerHostKind = 'tailscale' | 'lan' | 'loopback'
export type AccessHostKind = ServerHostKind | 'browser'

export interface ServerHost {
  kind: ServerHostKind
  label: string
  host: string
}

/**
 * One address this dashboard's server knows about, or the one it cannot: the
 * hostname this browser tab is actually using right now. `label` is `null`
 * only for `kind: 'browser'` — the server never sent one for that address (it
 * has no way to know it), so the component supplies its own translated label
 * rather than this module inventing English text.
 */
export interface AccessHost {
  kind: AccessHostKind
  label: string | null
  host: string
}

export interface AccessUrlEntry {
  key: string
  host: AccessHost
  port: number
  protocol: 'tcp' | 'udp'
  containerName: string
  /** `null` for udp — a browser cannot open it, so there is nothing to link
   * or copy, only to note. */
  url: string | null
}

/**
 * Every host address worth trying, deduped by the address itself.
 *
 * The browser's own hostname is appended last and dropped if it duplicates a
 * server-reported one (most commonly loopback, when this dashboard is opened
 * on the same box docker runs on) — a reader picking from this list has no
 * use for the same address twice under two different labels.
 */
export function collectHosts(serverHosts: ServerHost[], browserHostname: string): AccessHost[] {
  const hosts: AccessHost[] = serverHosts.map((h) => ({
    kind: h.kind,
    label: h.label,
    host: h.host,
  }))
  const seen = new Set(hosts.map((h) => h.host))
  const trimmed = browserHostname.trim()
  if (trimmed && !seen.has(trimmed)) {
    hosts.push({ kind: 'browser', label: null, host: trimmed })
  }
  return hosts
}

/**
 * Every URL a running container's published ports could be reached by,
 * crossed with every host address this box is known by. Pure and
 * unit-tested on its own (docker-access-urls.test.ts) — the reasons for each
 * choice below live there, not in the component that renders the result.
 */
export function buildAccessUrls(
  hosts: AccessHost[],
  containers: DockerContainer[],
): AccessUrlEntry[] {
  const running = containers.filter((c) => c.state === 'running')
  const entries: AccessUrlEntry[] = []

  for (const container of running) {
    for (const port of container.ports) {
      for (const host of hosts) {
        entries.push({
          key: `${host.kind}:${host.host}:${port.hostPort}:${port.protocol}:${container.id}`,
          host,
          port: port.hostPort,
          protocol: port.protocol,
          containerName: container.name,
          // A browser cannot open a udp:// URL — there is no such scheme —
          // so this is left for the caller to render as a note, not a link.
          url: port.protocol === 'tcp' ? `http://${host.host}:${port.hostPort}` : null,
        })
      }
    }
  }

  return entries
}
