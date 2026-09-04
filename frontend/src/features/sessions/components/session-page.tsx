import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Inline,
  PageHeader,
  Spinner,
  Stack,
  StatusDot,
  Textarea,
} from '@/shared/ui'
import { useSessionStream } from '../hooks/use-session-stream'
import {
  type SessionMessage,
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

// A shared empty array rather than a fresh `[]` per render: `Transcript` is
// memoised on this identity, and a new one each time would defeat it for the
// whole of the first load.
const NO_MESSAGES: SessionMessage[] = []

export function SessionPage({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const session = useSession(sessionId)
  const messages = useSessionMessages(sessionId)
  const send = useSendMessage(sessionId)
  const interrupt = useInterruptSession(sessionId)
  const { connected } = useSessionStream(sessionId)

  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const list = messages.data ?? NO_MESSAGES
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
    // Cleared now, not in `onSuccess`. Enter sends and people carry straight on
    // typing the next prompt, but the clear used to wait for the round-trip to
    // come back — so the box still held the sent text, the next few keystrokes
    // appended to it, and the late `setText('')` then wiped them. Consistently
    // the first two or three characters of every message after the first.
    setText('')
    pinned.current = true
    send.mutate(
      { path: { id: sessionId }, body: { text: value } },
      {
        onError: (e) => {
          // Hand the text back rather than losing it, but only into a box still
          // empty: by now the next prompt may already be part-typed, and
          // restoring over that would repeat the bug this replaced.
          setText((current) => (current === '' ? value : current))
          setError(apiErrorMessage(e, t('sessions.sendFailed')))
        },
      },
    )
  }

  if (session.isPending) return <Spinner label={t('common.loading')} block />
  if (session.isError || !session.data) {
    return <Alert tone="danger">{apiErrorMessage(session.error, t('sessions.loadFailed'))}</Alert>
  }

  const data = session.data

  return (
    <div className={styles.page}>
      <header>
        <Card padding="md">
          <PageHeader
            title={data.title ?? t('sessions.untitled', { id: data.id.slice(0, 8) })}
            description={
              // Phrasing content only (Badge is a span, Code an inline <code>):
              // PageHeader renders `description` inside a <p>, and a <div> in
              // there would auto-close it.
              <span className={styles.meta}>
                <Badge tone={STATUS_TONE[data.status]}>{t(`sessions.status.${data.status}`)}</Badge>
                {data.orchestrator && <span>{data.orchestrator}</span>}
                {data.branch && <Code>{data.branch}</Code>}
                {data.totalCostUsd > 0 && <span>${data.totalCostUsd.toFixed(4)}</span>}
                {data.pendingPrompts > 0 && (
                  <span>{t('sessions.pendingPrompts', { count: data.pendingPrompts })}</span>
                )}
              </span>
            }
            actions={
              <>
                <span className={styles.live}>
                  <StatusDot tone={connected ? 'accent' : 'neutral'} />
                  {connected ? t('sessions.live') : t('sessions.reconnecting')}
                </span>
                {busy && (
                  <Button
                    type="button"
                    onClick={() => interrupt.mutate({ path: { id: sessionId } })}
                  >
                    {t('sessions.stop')}
                  </Button>
                )}
                {/* Plain anchor, not a fetch/blob download: no object-URL lifecycle to
                    leak, no Content-Disposition filename to parse client-side, and it
                    works even while the transcript query is still pending. */}
                <Button asChild>
                  <a href={`/api/sessions/${sessionId}/export`} download>
                    {t('sessions.export')}
                  </a>
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void navigate({ to: '/projects/$projectId/sessions', params: { projectId } })
                  }
                >
                  {t('sessions.backToList')}
                </Button>
              </>
            }
          />
        </Card>
      </header>

      {data.lastError && <Alert tone="danger">{data.lastError}</Alert>}

      <div className={styles.scroll} ref={scroller} onScroll={onScroll}>
        {messages.isPending ? (
          <Spinner label={t('common.loading')} block />
        ) : (
          <Transcript messages={list} />
        )}
      </div>

      <Card padding="md">
        <Stack gap={2}>
          <Textarea
            value={text}
            rows={3}
            maxRows={11}
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
          <Inline justify="between" gap={3}>
            <span className={styles.hint}>
              {busy ? t('sessions.willQueue') : t('sessions.sendHint')}
            </span>
            <Button type="button" onClick={submit} disabled={send.isPending || !text.trim()}>
              {send.isPending ? t('sessions.sending') : t('sessions.send')}
            </Button>
          </Inline>
          {!data.orchestrator && <Alert tone="warning">{t('sessions.needsOrchestrator')}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
        </Stack>
      </Card>
    </div>
  )
}
