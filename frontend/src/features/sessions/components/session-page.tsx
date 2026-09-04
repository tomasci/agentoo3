import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ActionsMenu,
  Alert,
  Badge,
  Button,
  Code,
  Spinner,
  Stack,
  StatusDot,
  Textarea,
} from '@/shared/ui'
import { useSessionStream } from '../hooks/use-session-stream'
import {
  useInterruptSession,
  useSendMessage,
  useSession,
  useSessionMessages,
} from '../hooks/use-sessions'
import styles from './session-page.module.scss'
import { Transcript } from './transcript'

const BUSY = ['queued', 'running']

// A pill's tone for each session status. 'idle'/'queued' get the untoned
// default: nothing to flag yet.
const STATUS_TONE = {
  idle: 'neutral',
  queued: 'neutral',
  running: 'accent',
  interrupted: 'warning',
  completed: 'success',
  failed: 'danger',
} as const

export function SessionPage({ sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const messages = useSessionMessages(sessionId)
  const send = useSendMessage(sessionId)
  const interrupt = useInterruptSession(sessionId)
  const { connected } = useSessionStream(sessionId)

  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const list = messages.data ?? []
  const busy = BUSY.includes(session.data?.status ?? '')

  // Follow the transcript only while the reader is already at the bottom, so
  // scrolling up to read something does not get yanked back by the next message.
  // list.length is the trigger rather than a value the effect reads: a new
  // message is exactly when the scroll position needs revisiting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explained above
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [list.length])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const submit = () => {
    const value = text.trim()
    if (!value) return
    setError(null)
    send.mutate(
      { path: { id: sessionId }, body: { text: value } },
      {
        onSuccess: () => {
          setText('')
          pinned.current = true
        },
        onError: (e) => setError(apiErrorMessage(e, t('sessions.sendFailed'))),
      },
    )
  }

  if (session.isPending) return <Spinner label={t('common.loading')} block />
  if (session.isError || !session.data) {
    return <Alert tone="danger">{apiErrorMessage(session.error, t('sessions.loadFailed'))}</Alert>
  }

  const data = session.data
  const title = data.title ?? t('sessions.untitled', { id: data.id.slice(0, 8) })

  // Queue state that matters when you are about to type, not when you glance
  // at the title (that's why it moved out of the header): whether sending now
  // would just join a queue, and how many prompts are already waiting in it.
  const queueLine = [
    busy && t('sessions.willQueue'),
    data.pendingPrompts > 0 && t('sessions.pendingPrompts', { count: data.pendingPrompts }),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Badge tone={STATUS_TONE[data.status]}>{t(`sessions.status.${data.status}`)}</Badge>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.meta}>
          {/* Set-once configuration, not live status — it steps aside below
              `md` so the row has room for what actually changes. */}
          {data.orchestrator && <span className={styles.orchestrator}>{data.orchestrator}</span>}
          {data.branch && <Code>{data.branch}</Code>}
          {data.totalCostUsd > 0 && <span>${data.totalCostUsd.toFixed(4)}</span>}
          <span className={styles.live}>
            <StatusDot tone={connected ? 'accent' : 'neutral'} />
            {connected ? t('sessions.live') : t('sessions.reconnecting')}
          </span>
        </div>
        <div className={styles.actions}>
          {/* Visible at every size while busy: the only way to halt a running
              agent does not belong behind a menu. */}
          {busy && (
            <Button
              type="button"
              size="sm"
              onClick={() => interrupt.mutate({ path: { id: sessionId } })}
            >
              {t('sessions.stop')}
            </Button>
          )}
          <ActionsMenu
            label={t('sessions.actionsFor', { name: title })}
            actions={[
              {
                id: 'export',
                label: t('sessions.export'),
                onSelect: () => {
                  // A programmatic anchor click, not a fetch/blob: no
                  // object-URL lifecycle to leak, and `download` keeps this a
                  // save rather than a navigation regardless of whether the
                  // response sets Content-Disposition.
                  const a = document.createElement('a')
                  a.href = `/api/sessions/${sessionId}/export`
                  a.download = ''
                  a.click()
                },
              },
            ]}
          />
        </div>
      </header>

      {data.lastError && <Alert tone="danger">{data.lastError}</Alert>}

      <div className={styles.scroll} ref={scroller} onScroll={onScroll}>
        {messages.isPending ? (
          <Spinner label={t('common.loading')} block />
        ) : (
          <Transcript messages={list} />
        )}
      </div>

      <footer className={styles.composer}>
        <Stack gap={2}>
          {queueLine && <span className={styles.queueStatus}>{queueLine}</span>}
          <div className={styles.composerRow}>
            <div className={styles.textareaWrap}>
              <Textarea
                value={text}
                autoresize
                rows={2}
                maxRows={8}
                resize="none"
                onChange={(e) => setText(e.target.value)}
                placeholder={t('sessions.composerPlaceholder')}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. A prompt is usually one
                  // line, and reaching for the mouse for every send is worse.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            </div>
            <Button type="button" onClick={submit} disabled={send.isPending || !text.trim()}>
              {send.isPending ? t('sessions.sending') : t('sessions.send')}
            </Button>
          </div>
          {!data.orchestrator && <Alert tone="warning">{t('sessions.needsOrchestrator')}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
        </Stack>
      </footer>
    </div>
  )
}
