import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Inline, Stack, StatusDot } from '@/shared/ui'
import { cx } from '@/shared/ui/lib/cx'
import { useContainerLogs } from '../hooks/use-container-logs'
import styles from './container-logs.module.scss'

/**
 * One container's live logs, streamed — see use-container-logs.ts for the
 * reconnect and cap behaviour. The caller (service-list.tsx's
 * `ContainerPanel`) only ever mounts this while its own log pane is open
 * (`{open && <ContainerLogs .../>}`, not `Collapsible`'s `unmountOnExit` —
 * see that file's own comment on why): this component's effect starts the
 * connection on mount and tears it down on unmount, so that mount/unmount is
 * what actually keeps a closed pane from streaming at all.
 */
export function ContainerLogs({
  projectId,
  sessionId,
  containerId,
}: {
  projectId: string
  /** Scopes the stream to this session's own worktree — omitted means the
   *  project's repo/ checkout, exactly like every other docker call here. */
  sessionId?: string
  containerId: string
}) {
  const { t } = useTranslation()
  const { entries, connected, reconnecting, ended } = useContainerLogs(
    projectId,
    containerId,
    sessionId,
  )
  const paneRef = useRef<HTMLDivElement>(null)

  // Sticks to the bottom only when the reader was already there — scrolled
  // up to read history, the next line must not yank the view back down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries is the scroll trigger, not a value read inside this effect
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        {/* Three states, not two: a reader stuck on "disconnected" during a
            30s backoff wait has no way to tell a stalled stream (the server's
            8-per-process cap, or the daemon down) from a container that is
            simply quiet right now — see use-container-logs.ts's own note on
            why the retry is backed off in the first place. */}
        <StatusDot
          tone={connected ? 'success' : reconnecting ? 'warning' : 'neutral'}
          pulse={connected || reconnecting}
        />
        <span className={styles.status}>
          {connected
            ? t('docker.logs.streaming')
            : reconnecting
              ? t('docker.logs.reconnecting')
              : t('docker.logs.connecting')}
        </span>
      </Inline>

      <div ref={paneRef} className={styles.pane}>
        {entries.length === 0 ? (
          <p className={styles.empty}>{t('docker.logs.empty')}</p>
        ) : (
          entries.map((entry) =>
            entry.kind === 'dropped' ? (
              <p key={entry.id} className={styles.dropped}>
                {t('docker.logs.dropped', { count: entry.lines })}
              </p>
            ) : (
              <p
                key={entry.id}
                className={cx(styles.line, entry.stream === 'stderr' && styles.stderr)}
              >
                {entry.text}
              </p>
            ),
          )
        )}
      </div>

      {ended && (
        <Alert tone={ended.reason === 'error' ? 'danger' : 'neutral'}>
          {t(`docker.logs.ended.${ended.reason}`)}
          {ended.message ? `: ${ended.message}` : ''}
        </Alert>
      )}
    </Stack>
  )
}
