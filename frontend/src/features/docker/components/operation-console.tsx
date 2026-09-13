import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Badge, Button, Card, Inline, Stack, StatusDot, type Tone } from '@/shared/ui'
import { cx } from '@/shared/ui/lib/cx'
import { useOperationStream } from '../hooks/use-operation-stream'
import styles from './operation-console.module.scss'

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
      <Stack gap={3}>
        <Inline gap={3} justify="between" align="center">
          <Inline gap={2} align="center">
            <StatusDot tone={connected ? 'accent' : 'neutral'} pulse={connected && !ended} />
            <h3 className={styles.heading}>
              {operation
                ? t(`docker.operation.kind.${operation.kind}`)
                : t('docker.operation.heading')}
            </h3>
            <Badge tone={STATUS_TONE[status]}>{t(`docker.operation.status.${status}`)}</Badge>
          </Inline>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t('docker.operation.dismiss')}
          </Button>
        </Inline>

        {operation && operation.services.length > 0 && (
          <p className={styles.services}>
            {t('docker.operation.services', { names: operation.services.join(', ') })}
          </p>
        )}

        <div ref={paneRef} className={styles.pane}>
          {lines.length === 0 ? (
            <p className={styles.empty}>{t('docker.operation.empty')}</p>
          ) : (
            lines.map((line) => (
              <p
                key={line.seq}
                className={cx(styles.line, line.stream === 'stderr' && styles.stderr)}
              >
                {line.text}
              </p>
            ))
          )}
        </div>

        {operation?.error && <Alert tone="danger">{operation.error}</Alert>}
      </Stack>
    </Card>
  )
}
