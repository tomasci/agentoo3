import { CircleAlertIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusBadge, StatusDot, type Tone } from '@/shared/components'
import { cn } from '@/shared/lib/utils'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { useOperationStream } from '../hooks/use-operation-stream'

type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed'

const STATUS_TONE: Record<OperationStatus, Tone> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
}

/**
 * Live output and status for the operation a mutation just queued — a
 * `compose up --build` can take minutes, and this is the one place that
 * progress is actually visible rather than a spinner with nothing behind it.
 *
 * `operationId` is a prop rather than read off the docker status query
 * itself: the caller (docker-page.tsx) decides which operation this console
 * is for — the one it just triggered, or (on reload, mid-operation) whatever
 * the status query's own `activeOperationId` names.
 */
export function OperationConsole({
  projectId,
  operationId,
  onDismiss,
}: {
  projectId: string
  operationId: string
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const { operation, lines, connected, ended } = useOperationStream(projectId, operationId)
  const paneRef = useRef<HTMLDivElement>(null)

  // Sticks to the bottom only when the reader was already there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines is the scroll trigger, not a value read inside this effect
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [lines])

  const status = operation?.status ?? 'queued'

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusDot tone={connected ? 'accent' : 'neutral'} pulse={connected && !ended} />
            <h3 className="text-base font-semibold">
              {operation
                ? t(`docker.operation.kind.${operation.kind}`)
                : t('docker.operation.heading')}
            </h3>
            <StatusBadge tone={STATUS_TONE[status]}>
              {t(`docker.operation.status.${status}`)}
            </StatusBadge>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t('docker.operation.dismiss')}
          </Button>
        </div>

        {operation && operation.services.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('docker.operation.services', { names: operation.services.join(', ') })}
          </p>
        )}

        <div
          ref={paneRef}
          className="max-h-64 overflow-y-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="m-0 text-muted-foreground">{t('docker.operation.empty')}</p>
          ) : (
            lines.map((line) => (
              <p
                key={line.seq}
                className={cn(
                  'm-0 break-words whitespace-pre-wrap',
                  line.stream === 'stderr' && 'text-destructive',
                )}
              >
                {line.text}
              </p>
            ))
          )}
        </div>

        {operation?.error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{operation.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
