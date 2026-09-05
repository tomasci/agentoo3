import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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

// `projectId` stays in the prop type — the route still supplies it — but is no
// longer destructured: the only thing that read it was the back-to-list button.
export function SessionPage({ sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const messages = useSessionMessages(sessionId)
  const send = useSendMessage(sessionId)
  const interrupt = useInterruptSession(sessionId)
  // Gated on the messages query's own success, not just mount: opening the
  // stream before that first page has landed leaves nothing in the cache to
  // seed `lastSeq` from, so the backend treats it as a brand new reader and
  // replays the entire transcript down the stream on top of the REST fetch
  // that just did the same thing.
  const { connected } = useSessionStream(sessionId, messages.isSuccess)

  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Guards `requestOlder` against re-entry: a fetch already in flight does not
  // flip `messages.isLoadingOlder` (react-query state, seen only on the next
  // render) until after this synchronous call returns, and momentum-scrolling
  // near the top can fire many `scroll` events before that render happens.
  const loadingOlder = useRef(false)
  // `scrollHeight` recorded just before a `loadOlder` fetch, consumed by the
  // layout effect below once the older page lands. `null` means "no prepend
  // to compensate for" — the ordinary case of every render that is not that
  // one.
  const pendingScrollAdjust = useRef<number | null>(null)

  const requestOlder = () => {
    const el = scroller.current
    // `hasPreviousPage`, not `hasOlder`: the latter is only ever the *first*
    // loaded page's own flag, so a page that ever comes back empty while
    // still claiming `hasOlder: true` would leave this guard permanently
    // open on a button that can no longer fetch anything (`getPreviousPageParam`
    // has nothing to anchor on and returns `undefined` forever). `hasPreviousPage`
    // is derived from that same function, so it is false in exactly the cases
    // where fetching again would be a no-op.
    if (!el || loadingOlder.current || !messages.hasPreviousPage) return
    loadingOlder.current = true
    pendingScrollAdjust.current = el.scrollHeight
    // A prepend is a scrollback read, never "stay pinned to the bottom" — even
    // a short first page that fits the whole viewport reads as `pinned` under
    // the at-bottom heuristic below, and without this it would get yanked
    // back down the moment older history landed above it.
    pinned.current = false
    void messages.loadOlder().finally(() => {
      loadingOlder.current = false
    })
  }

  // The oldest loaded message's own seq, not `messages.messages` itself: it
  // moves only when a page is *prepended* (a lower seq now leads the array),
  // and is untouched by the stream appending at the tail — which is exactly
  // the distinction that keeps this effect from ever firing for the wrong
  // reason and fighting the pin-to-bottom ResizeObserver below.
  const oldestSeq = messages.messages[0]?.seq
  // biome-ignore lint/correctness/useExhaustiveDependencies: oldestSeq is the trigger, not a value read inside
  useLayoutEffect(() => {
    const el = scroller.current
    const recorded = pendingScrollAdjust.current
    pendingScrollAdjust.current = null
    if (!el || recorded === null) return
    // Inserting older messages above the viewport pushes everything already
    // on screen down by exactly the height that was added; without this the
    // reader is thrown backwards to whatever now occupies their old scroll
    // position. Reassigning `scrollTop` here rather than trusting the
    // browser's own scroll anchoring, which is not specified to survive a
    // batch insert above the viewport.
    el.scrollTop += el.scrollHeight - recorded
  }, [oldestSeq])

  // Keeps the transcript pinned to the bottom as its true height settles, not
  // only when a message arrives: `.row`'s `content-visibility: auto` (see
  // transcript.module.scss) makes `scrollHeight` an *estimate* for a row never
  // yet rendered, so a single `scrollTop = scrollHeight` on the old message
  // count can land short of the real bottom once markdown or code in that row
  // resolves taller than its placeholder. A `ResizeObserver` on the rendered
  // content re-asserts the pin every time its layout height actually changes,
  // which covers that settling as well as ordinary growth — and does so only
  // while `pinned.current` is true, so a prepend (which clears it in
  // `requestOlder` above, even from a short first page that reads as "at the
  // bottom") is never mistaken for "content grew, so follow it".
  const setContent = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const observer = new ResizeObserver(() => {
      const el = scroller.current
      if (el && pinned.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    // Follow the transcript only while the reader is already at the bottom,
    // so scrolling up to read something does not get yanked back by the next
    // message.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 80) requestOlder()
  }

  const busy = BUSY.includes(session.data?.status ?? '')

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
          <div ref={setContent}>
            {messages.hasPreviousPage && (
              <div className={styles.loadOlder}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={requestOlder}
                  loading={messages.isLoadingOlder}
                  loadingLabel={t('sessions.transcript.loadingOlder')}
                >
                  {t('sessions.transcript.loadOlder')}
                </Button>
                {messages.isLoadOlderError && (
                  <Alert tone="danger">{t('sessions.transcript.loadOlderFailed')}</Alert>
                )}
              </div>
            )}
            <Transcript messages={messages.messages} />
          </div>
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
