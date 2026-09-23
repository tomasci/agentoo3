import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Stack } from '@/shared/ui'
import { cx } from '@/shared/ui/lib/cx'
import type { EditorOperation } from '../hooks/use-editor'
import styles from './editor-start-log.module.scss'

/**
 * The output of the session's last start — polled, not streamed. Unlike
 * Docker's `OperationConsole` (features/docker/components/operation-console.tsx),
 * `editor-op` has no SSE channel (design doc §4: "Progress: polled (no SSE)"),
 * so there is no live-connection state to show here — every `useEditorStatus`
 * refetch just carries a newer `operation.output` snapshot, already capped by
 * the backend to the last 200 lines.
 *
 * `operation` is nullable: a session that has never been started has nothing
 * to show yet, which renders as the same "waiting for output" empty state a
 * genuinely empty `output[]` would.
 */
export function EditorStartLog({ operation }: { operation: EditorOperation | null }) {
  const { t } = useTranslation()
  const lines = operation?.output ?? []
  const paneRef = useRef<HTMLDivElement>(null)

  // Sticks to the bottom only when the reader was already there — the same
  // idiom as OperationConsole's own pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines is the scroll trigger, not a value read inside this effect
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <Card>
      <Stack gap={2}>
        <h3 className={styles.heading}>{t('editor.log.heading')}</h3>
        <div ref={paneRef} className={styles.pane}>
          {lines.length === 0 ? (
            <p className={styles.empty}>{t('editor.log.empty')}</p>
          ) : (
            // No id of its own, and `at` is not unique enough on its own
            // (several lines can land in the same millisecond) — position is
            // stable regardless, since this is an append-only snapshot the
            // page never reorders.
            lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <p key={i} className={cx(styles.line, line.stream === 'stderr' && styles.stderr)}>
                {line.text}
              </p>
            ))
          )}
        </div>
      </Stack>
    </Card>
  )
}
