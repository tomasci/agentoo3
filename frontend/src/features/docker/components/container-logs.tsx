import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { useContainerLogs } from '../hooks/use-container-logs'

/**
 * One container's live logs, streamed — see use-container-logs.ts for the
 * reconnect and cap behaviour. The caller (service-list.tsx's
 * `ContainerPanel`) only ever mounts this while its own log pane is open
 * (`{open && <ContainerLogs .../>}`, not `Collapsible`'s own unmounting —
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {/* Three states, not two: a reader stuck on "disconnected" during a
            30s backoff wait has no way to tell a stalled stream (the server's
            8-per-process cap, or the daemon down) from a container that is
            simply quiet right now — see use-container-logs.ts's own note on
            why the retry is backed off in the first place. */}
        <StatusDot
          tone={connected ? 'success' : reconnecting ? 'warning' : 'neutral'}
          pulse={connected || reconnecting}
        />
        <span className="text-xs text-muted-foreground">
          {connected
            ? t('docker.logs.streaming')
            : reconnecting
              ? t('docker.logs.reconnecting')
              : t('docker.logs.connecting')}
        </span>
      </div>

      <div
        ref={paneRef}
        className="max-h-64 overflow-y-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed"
      >
        {entries.length === 0 ? (
          <p className="m-0 text-muted-foreground">{t('docker.logs.empty')}</p>
        ) : (
          entries.map((entry) =>
            entry.kind === 'dropped' ? (
              <p key={entry.id} className="my-1 text-muted-foreground italic">
                {t('docker.logs.dropped', { count: entry.lines })}
              </p>
            ) : (
              <p
                key={entry.id}
                className={cn(
                  'm-0 break-words whitespace-pre-wrap',
                  entry.stream === 'stderr' && 'text-destructive',
                )}
              >
                {entry.text}
              </p>
            ),
          )
        )}
      </div>

      {ended &&
        (ended.reason === 'error' ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>
              {t(`docker.logs.ended.${ended.reason}`)}
              {ended.message ? `: ${ended.message}` : ''}
            </AlertDescription>
          </Alert>
        ) : (
          // A plain, untinted note rather than a destructive alert — the
          // container exiting cleanly or the stream simply ending is not a
          // problem this page needs to flag red.
          <Alert role="status">
            <AlertDescription>
              {t(`docker.logs.ended.${ended.reason}`)}
              {ended.message ? `: ${ended.message}` : ''}
            </AlertDescription>
          </Alert>
        ))}
    </div>
  )
}
