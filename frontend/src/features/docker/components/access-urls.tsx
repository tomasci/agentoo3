import { useTranslation } from 'react-i18next'
import { Card, CopyButton, EmptyState, Inline, PageHeader, Stack } from '@/shared/ui'
import { type AccessHost, buildAccessUrls, collectHosts, type ServerHost } from '../lib/access-urls'
import type { DockerContainer } from '../lib/state'
import styles from './access-urls.module.scss'

function hostLabel(host: AccessHost, t: (key: string) => string): string {
  // Every server-reported kind already carries its own label (tailscale.ts's
  // wording, not this component's); only the browser-derived one has none —
  // the server has no way to know what hostname this tab is using.
  return host.label ?? t('docker.accessUrls.thisBrowser')
}

/**
 * Every way a running container's published port might be reached, because
 * different people open this dashboard by different addresses (a tailnet
 * name, a LAN IP, an SSH tunnel's localhost, a `tailscale serve` alias) and
 * only one of those actually resolves for any one of them — so this
 * deliberately does not pick a favourite.
 */
export function AccessUrls({
  hosts,
  containers,
}: {
  hosts: ServerHost[]
  containers: DockerContainer[]
}) {
  const { t } = useTranslation()
  // `window.location.hostname`, not `.host` — the port belongs to *this*
  // page, not to whatever a container happens to publish, and is added back
  // in per-entry below.
  const allHosts = collectHosts(hosts, window.location.hostname)
  const entries = buildAccessUrls(allHosts, containers)

  return (
    <Card>
      <Stack gap={3}>
        <PageHeader level={3} title={t('docker.accessUrls.heading')} />

        {entries.length === 0 ? (
          <EmptyState size="sm" title={t('docker.accessUrls.empty')} />
        ) : (
          <Stack gap={2}>
            {entries.map((entry) => (
              <Inline key={entry.key} gap={3} justify="between" align="center">
                <Stack gap={0}>
                  <span className={styles.label}>
                    {hostLabel(entry.host, t)} · {entry.containerName}
                  </span>
                  {entry.url ? (
                    <a href={entry.url} target="_blank" rel="noreferrer" className={styles.urlLink}>
                      {entry.url}
                    </a>
                  ) : (
                    <span className={styles.udp}>
                      {entry.host.host}:{entry.port}/udp — {t('docker.accessUrls.udpNote')}
                    </span>
                  )}
                </Stack>
                {entry.url && <CopyButton value={entry.url} label={t('common.copy')} />}
              </Inline>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
