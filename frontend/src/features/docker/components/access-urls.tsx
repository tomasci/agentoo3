import { useTranslation } from 'react-i18next'
import { CopyButton, PageHeader } from '@/shared/components'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Item, ItemActions, ItemContent } from '@/shared/ui/item'
import { type AccessHost, buildAccessUrls, collectHosts, type ServerHost } from '../lib/access-urls'
import type { DockerContainer } from '../lib/state'

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
      <CardContent className="flex flex-col gap-3">
        <PageHeader level={3} title={t('docker.accessUrls.heading')} />

        {entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('docker.accessUrls.empty')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <Item key={entry.key} variant="outline" size="sm">
                <ItemContent className="gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    {hostLabel(entry.host, t)} · {entry.containerName}
                  </span>
                  {entry.url ? (
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all font-mono text-sm text-primary hover:underline"
                    >
                      {entry.url}
                    </a>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {entry.host.host}:{entry.port}/udp — {t('docker.accessUrls.udpNote')}
                    </span>
                  )}
                </ItemContent>
                {entry.url && (
                  <ItemActions>
                    <CopyButton value={entry.url} label={t('common.copy')} />
                  </ItemActions>
                )}
              </Item>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
