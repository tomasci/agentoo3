import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
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

  if (session.isPending) return <p>{t('common.loading')}</p>
  if (session.isError || !session.data) {
    return (
      <p className={styles.error}>{apiErrorMessage(session.error, t('sessions.loadFailed'))}</p>
    )
  }

  const data = session.data

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{data.title ?? t('sessions.untitled')}</h1>
          <div className={styles.meta}>
            <span>{t(`sessions.status.${data.status}`)}</span>
            {data.orchestrator && <span>{data.orchestrator}</span>}
            {data.branch && <span className={styles.mono}>{data.branch}</span>}
            {data.totalCostUsd > 0 && <span>${data.totalCostUsd.toFixed(4)}</span>}
            {data.pendingPrompts > 0 && (
              <span>{t('sessions.pendingPrompts', { count: data.pendingPrompts })}</span>
            )}
          </div>
        </div>

        <div className={styles.controls}>
          <span className={styles.live}>
            <span
              className={`${styles.dot} ${connected ? styles.dotLive : ''}`}
              aria-hidden="true"
            />
            {connected ? t('sessions.live') : t('sessions.reconnecting')}
          </span>
          {busy && (
            <Button type="button" onClick={() => interrupt.mutate({ path: { id: sessionId } })}>
              {t('sessions.stop')}
            </Button>
          )}
          <Button
            type="button"
            onClick={() =>
              void navigate({ to: '/projects/$projectId/sessions', params: { projectId } })
            }
          >
            {t('sessions.backToList')}
          </Button>
        </div>
      </header>

      <div className={styles.scroll} ref={scroller} onScroll={onScroll}>
        {messages.isPending ? <p>{t('common.loading')}</p> : <Transcript messages={list} />}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={text}
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
        <div className={styles.composerFoot}>
          <span className={styles.hint}>
            {busy ? t('sessions.willQueue') : t('sessions.sendHint')}
          </span>
          <Button type="button" onClick={submit} disabled={send.isPending || !text.trim()}>
            {send.isPending ? t('sessions.sending') : t('sessions.send')}
          </Button>
        </div>
        {!data.orchestrator && (
          <span className={styles.warn}>{t('sessions.needsOrchestrator')}</span>
        )}
        {error && <span className={styles.error}>{error}</span>}
      </div>
    </div>
  )
}
