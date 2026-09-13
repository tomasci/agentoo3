import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, Alert, Badge, Button, Code, Spinner, StatusDot } from '@/shared/ui'
import {
  type AttachmentUpload,
  useAttachmentUploads,
  useDeleteSessionFile,
  useSessionFiles,
} from '../hooks/use-session-files'
import { useSessionStream } from '../hooks/use-session-stream'
import {
  useInterruptSession,
  useSendMessage,
  useSession,
  useSessionMessages,
} from '../hooks/use-sessions'
import { type MessagesData, sessionMessagesKey } from '../lib/message-cache'
import { Composer } from './composer'
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

/**
 * A row's position relative to the *viewport*, not its `offsetTop` in the
 * document: where the engine's own scroll anchoring has already compensated
 * for a prepend (Chrome, Firefox), this delta comes out zero and the caller's
 * write is a no-op. That is what makes reapplying it safe everywhere —
 * `hold`'s later passes, and `onScroll` re-recording it while a fetch is
 * still in flight — on both the browsers that anchor and the one that (as of
 * this writing) does not.
 */
function offsetOf(el: HTMLElement, scroller: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
}

/**
 * The row a `requestOlder` prepend should anchor its scroll compensation on:
 * the bottom-most `[data-transcript-row]` (tagged in transcript.tsx, one per
 * top-level node, in document order) at least partly inside the viewport.
 *
 * Bottom-most, not first: `buildTranscript` can restructure the first row
 * when an older page heals a turn split across the page boundary, so it can
 * vanish from the DOM entirely once that page lands — anchoring on it would
 * leave nothing to reattach to. Nothing between a visible row and the
 * viewport's bottom edge can change size, so this row's offset delta is
 * exactly the shift the reader experiences.
 *
 * Returns `null` — no anchor, no compensation, rather than a guess — for a
 * transcript shorter than the viewport (nothing yet qualifies) or before this
 * attribute exists in the tree at all.
 */
function pickAnchor(el: HTMLElement): { el: HTMLElement; offset: number } | null {
  const rows = el.querySelectorAll<HTMLElement>('[data-transcript-row]')
  const bottomEdge = el.getBoundingClientRect().bottom
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row && row.getBoundingClientRect().top < bottomEdge) {
      return { el: row, offset: offsetOf(row, el) }
    }
  }
  return null
}

// `projectId` stays in the prop type — the route still supplies it — but is no
// longer destructured: the only thing that read it was the back-to-list button.
export function SessionPage({ sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
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

  const files = useSessionFiles(sessionId)
  const uploads = useAttachmentUploads(sessionId)
  const deleteFile = useDeleteSessionFile(sessionId)

  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Guards `requestOlder` against re-entry: a fetch already in flight does not
  // flip `messages.isLoadingOlder` (react-query state, seen only on the next
  // render) until after this synchronous call returns, and momentum-scrolling
  // near the top can fire many `scroll` events before that render happens.
  const loadingOlder = useRef(false)
  // The row `requestOlder` picked to anchor a prepend on, and the viewport
  // offset it had at that moment (see `pickAnchor`/`offsetOf` above). `null`
  // means "no prepend to compensate for" — the ordinary case of every render
  // that is not that one. Kept live by `onScroll` below while a fetch is in
  // flight, so scrolling during the fetch is preserved rather than fought.
  const anchor = useRef<{ el: HTMLElement; offset: number } | null>(null)
  // The oldest loaded message's own seq, not `messages.messages` itself: it
  // moves only when a page is *prepended* (a lower seq now leads the array),
  // and is untouched by the stream appending at the tail — which is exactly
  // the distinction that keeps the layout effect below from ever firing for
  // the wrong reason and fighting the pin-to-bottom effect. Computed here,
  // ahead of `requestOlder`, because `requestOlder` needs its *current* value
  // (captured before the fetch) to later tell whether that fetch actually
  // prepended anything.
  const oldestSeq = messages.messages[0]?.seq
  // True from the moment a finger touches the transcript until 200ms after it
  // — or the momentum it left behind — stops moving things. Suppresses the
  // pin-to-bottom effect for that whole window: a `scrollTop` write while iOS
  // is still mid-gesture is what turns "content grew" into a fight the
  // reader loses.
  const interacting = useRef(false)
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Frame ids `hold` (below) has scheduled and not yet run, so a later call
  // can cancel them rather than pile a write from an earlier call on top of
  // a newer one.
  const pendingFrames = useRef<number[]>([])

  const clearInteractionTimer = () => {
    if (interactionTimer.current !== null) {
      clearTimeout(interactionTimer.current)
      interactionTimer.current = null
    }
  }

  // Re-asserts `correct` at commit and on every animation frame after, until
  // it reports nothing left to correct for two frames running, or 500ms have
  // passed since the hold started — whichever comes first, cancelling
  // whatever an earlier call left outstanding. A row inserted under
  // `content-visibility: auto` (transcript.module.scss) contributes its 6rem
  // placeholder at commit and its real height only once the engine judges it
  // relevant and renders it — which takes an unpredictable number of frames,
  // because every correction moves the viewport, which changes which rows
  // now fall inside the relevance margin. A fixed number of passes cannot
  // bound that; only "keep going until it stops mattering" can. `correct`
  // performs one write and reports how many pixels it actually moved the
  // scroller by, 0 once there is nothing left to do, which is what lets both
  // callers below share this without either one having to know how many
  // passes the other needs.
  const hold = (correct: () => number) => {
    for (const frame of pendingFrames.current) cancelAnimationFrame(frame)
    const deadline = Date.now() + 500
    let stableFrames = 0
    const step = () => {
      stableFrames = correct() === 0 ? stableFrames + 1 : 0
      if (stableFrames >= 2 || Date.now() >= deadline) {
        pendingFrames.current = []
        return
      }
      pendingFrames.current = [requestAnimationFrame(step)]
    }
    step()
  }

  // Shared by both places that pin the transcript to the bottom — the effect
  // below, and the interaction timer's own catch-up once a gesture ends —
  // so the per-frame `interacting` re-check only has to be gotten right once.
  const holdAtBottom = () => {
    const el = scroller.current
    if (!el) return
    hold(() => {
      // Checked every frame, not just before the hold starts: a finger can
      // touch down while a hold from an earlier arrival is still running,
      // and writing `scrollTop` under it is exactly what turns "content
      // grew" into a fight the reader loses (see `interacting`'s comment
      // above) — the gate this replaces used to check that once, at commit,
      // which an unbounded hold can no longer get away with.
      if (interacting.current) return 0
      const before = el.scrollTop
      el.scrollTop = el.scrollHeight - el.clientHeight
      return el.scrollTop - before
    })
  }

  // (Re)arms the 200ms window that closes a touch interaction. iOS keeps
  // delivering `scroll` events well after a finger lifts (momentum), so
  // `onScroll` below restarts this timer for as long as that continues — only
  // once nothing has moved for the full 200ms is the gesture actually over.
  const armInteractionTimer = () => {
    clearInteractionTimer()
    interactionTimer.current = setTimeout(() => {
      interactionTimer.current = null
      interacting.current = false
      // Whatever arrived while the guard was up is not left stranded
      // off-screen — applied once here, not resumed as an ongoing follow:
      // the pin effect below declined to run while this was armed, and
      // nothing re-arms it except a genuine new arrival.
      if (pinned.current) holdAtBottom()
    }, 200)
  }

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
    anchor.current = pickAnchor(el)
    // A prepend is a scrollback read, never "stay pinned to the bottom" — even
    // a short first page that fits the whole viewport reads as `pinned` under
    // the at-bottom heuristic below, and without this it would get yanked
    // back down the moment older history landed above it.
    pinned.current = false
    // The seq before the fetch, so `.finally()` below can tell whether it
    // actually prepended anything.
    const startedAtSeq = oldestSeq
    void messages.loadOlder().finally(() => {
      loadingOlder.current = false
      // An empty page, or a fetch that failed, never moves the oldest cached
      // seq — so the `oldestSeq`-keyed layout effect below never runs to
      // consume and clear `anchor.current`, leaving `onScroll` to keep
      // recomputing `offsetOf` against a row nothing will ever compensate for
      // again. Read the cache directly rather than through `messages`: that
      // binding is frozen at whichever render `requestOlder` was called from,
      // and by the time this callback runs, react-query has already written
      // the fetch's result into the cache (that write happens synchronously
      // as part of settling this same promise) even if React has not
      // re-rendered from it yet — so the cache, not this closure, is the
      // only value guaranteed fresh here.
      const cached = queryClient.getQueryData<MessagesData>(sessionMessagesKey(sessionId))
      const freshOldestSeq = cached?.pages[0]?.messages[0]?.seq
      if (freshOldestSeq === startedAtSeq) anchor.current = null
    })
  }

  // The IntersectionObserver set up in the effect below is created once per
  // sentinel mount, so it has to reach the *current* `requestOlder` (and the
  // `messages` it closes over) through a ref rather than by closing over this
  // render's copy directly — otherwise it would keep testing `hasPreviousPage`
  // from whichever render happened to mount the sentinel, forever. Assigned
  // directly during render rather than in an effect: the write is idempotent
  // (the exact same function shape every time), so StrictMode's double render
  // costs nothing, and nothing ever reads it during render — only from inside
  // the observer's own callback, well after this render has committed.
  const requestOlderRef = useRef(requestOlder)
  requestOlderRef.current = requestOlder

  // The zero-height marker rendered immediately before `.loadOlder`, only
  // while `messages.hasPreviousPage` — so the observer disappears with the
  // affordance instead of needing to be told to stop separately.
  //
  // The ref callback below only *records* the node — it does not build the
  // IntersectionObserver itself. React attaches refs bottom-up within a
  // commit (children before parents), so on a warm cache (`staleTime:
  // Infinity` on both `useSession` and `useSessionMessages` — see those
  // hooks) a revisited session's very first render already has data and
  // mounts `.scroll`, the sentinel and the transcript all in the *same*
  // commit. Reading `scroller.current` from the sentinel's own ref callback
  // at that moment reads it before it has been attached — permanently null,
  // since a memoised ref callback is never invoked again once the node's
  // identity stops changing. An effect runs only after every ref in the
  // commit, child and parent alike, has been attached, which is what makes
  // reading `scroller.current` there safe. Do not move this back into the
  // ref callback.
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null)

  // `rootMargin` starts the fetch 300px before the sentinel is actually on
  // screen, and an IntersectionObserver only fires on a *transition* into
  // intersection, so bouncing at a top already reached (iOS rubber-band
  // overscroll) cannot re-fire it — that re-arm rule is why no other
  // threshold is needed. Kept as the explicit "load older" button's fallback
  // for a page shorter than the 300px margin: the sentinel would never stop
  // intersecting, and automatic loading quietly stops. Depends only on
  // `sentinelNode`'s own identity, not `messages.hasPreviousPage` directly:
  // the sentinel unmounts (node becomes `null`) exactly when that flag does,
  // so the node's own transitions already carry it.
  useEffect(() => {
    const root = scroller.current
    if (!sentinelNode || !root) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) requestOlderRef.current()
      },
      { root, rootMargin: '300px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinelNode)
    return () => observer.disconnect()
  }, [sentinelNode])

  // biome-ignore lint/correctness/useExhaustiveDependencies: oldestSeq is the trigger, not a value read inside
  useLayoutEffect(() => {
    const el = scroller.current
    const picked = anchor.current
    anchor.current = null
    if (!el || !picked) return
    // The anchor row is gone rather than merely pushed down: an older page
    // restructured it (see `pickAnchor` above). Nothing here can say by how
    // much the reader's position actually moved, so this does nothing rather
    // than guess.
    if (!picked.el.isConnected) return
    // Inserting older messages above the viewport pushes everything already
    // on screen down; reassigning `scrollTop` here rather than trusting the
    // browser's own scroll anchoring, which iOS Safari does not implement at
    // all. `offsetOf` is recomputed fresh on every `hold` pass, which is what
    // makes this idempotent: once the delta below is applied, the anchor
    // row's offset equals `picked.offset` again and every later pass adds
    // zero — until a placeholder resolves to its real height and throws the
    // delta off again, which is exactly what `hold` keeps re-correcting for.
    let lastWritten = el.scrollTop
    hold(() => {
      // The anchor row can itself be removed mid-hold — a second older page
      // landing inside the same 500ms window, restructuring the tree again
      // (see `pickAnchor` above). Nothing left to correct against, so this
      // is where the hold gives up rather than measuring a detached node.
      if (!picked.el.isConnected) return 0
      // The reader moved the scrollbar themselves since the last write —
      // under momentum, or simply reading on — so the delta below has to be
      // measured against *their* position, not the one recorded when this
      // hold started or last corrected. Reporting the drift itself as
      // "moved" is what keeps a genuine rebase from ever reading as settled.
      if (el.scrollTop !== lastWritten) {
        const drift = el.scrollTop - lastWritten
        picked.offset = offsetOf(picked.el, el)
        lastWritten = el.scrollTop
        return drift
      }
      const before = el.scrollTop
      el.scrollTop += offsetOf(picked.el, el) - picked.offset
      lastWritten = el.scrollTop
      return lastWritten - before
    })
  }, [oldestSeq])

  // Keeps the transcript pinned to the bottom while its content changes, not
  // only when a message arrives: `.row`'s `content-visibility: auto` (see
  // transcript.module.scss) makes `scrollHeight` an *estimate* for a row never
  // yet rendered, so `hold`'s later passes are what catch a row settling
  // taller than its placeholder once markdown or code in it resolves.
  //
  // Keyed on `messages.messages`' own identity, not a ResizeObserver on the
  // rendered content: `mergeSessionMessages`/`selectMessages`
  // (lib/message-cache.ts, hooks/use-sessions.ts) hand back the exact same
  // array reference for an arrival that changed nothing, so this never fires
  // for a render that has nothing new for it. Given up along with the
  // ResizeObserver it replaces: a row that grows *without* a new message
  // arriving — a running task's progress note updating in place — is no
  // longer followed. Re-adding that would mean re-adding the write-triggers-
  // resize-triggers-write loop that made the phone case unreasonable in the
  // first place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: holdAtBottom is a fresh closure every render (it closes only over refs, so it is never stale); messages.messages is the one thing that should retrigger this
  useLayoutEffect(() => {
    if (!scroller.current || !pinned.current || interacting.current) return
    holdAtBottom()
  }, [messages.messages])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clearInteractionTimer is a fresh closure every render (it closes only over the interactionTimer ref); this runs once, on unmount, regardless
  useEffect(() => {
    return () => {
      clearInteractionTimer()
      for (const frame of pendingFrames.current) cancelAnimationFrame(frame)
    }
  }, [])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    // Follow the transcript only while the reader is already at the bottom,
    // so scrolling up to read something does not get yanked back by the next
    // message.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Keeps the compensation anchored to whatever the reader is looking at
    // right now, not to where they were the instant `requestOlder` fired —
    // scrolling during a slow fetch is ordinary, and this is what preserves it.
    if (anchor.current) anchor.current.offset = offsetOf(anchor.current.el, el)
    // Momentum keeps delivering `scroll` events after a finger lifts; as long
    // as they keep coming, the interaction is not actually over yet.
    if (interacting.current) armInteractionTimer()
  }

  const onTouchStart = () => {
    interacting.current = true
    clearInteractionTimer()
  }
  const onTouchEnd = () => armInteractionTimer()
  const onTouchCancel = () => armInteractionTimer()

  const busy = BUSY.includes(session.data?.status ?? '')

  const submit = () => {
    const value = text.trim()
    // Also refuses while an upload is still in flight — see Composer's own
    // "why is send disabled" line, which reads this same count.
    if (!value || uploads.pendingCount > 0) return
    setError(null)
    // Cleared now, not in `onSuccess`. Enter sends and people carry straight on
    // typing the next prompt, but the clear used to wait for the round-trip to
    // come back — so the box still held the sent text, the next few keystrokes
    // appended to it, and the late `setText('')` then wiped them. Consistently
    // the first two or three characters of every message after the first.
    setText('')
    pinned.current = true
    // Read before the mutation fires, not inside `onSuccess`: by the time a
    // response comes back the reader may already have attached more files for
    // their *next* prompt, and clearing those from the tray here would be wrong.
    const attachedFileIds = uploads.uploads
      .filter((u) => u.status === 'done' && u.serverFile)
      .map((u) => u.serverFile?.id)
      .filter((id): id is string => id !== undefined)
    send.mutate(
      { path: { id: sessionId }, body: { text: value } },
      {
        onSuccess: () => {
          if (attachedFileIds.length > 0) uploads.clearSent(attachedFileIds)
        },
        onError: (e) => {
          // Hand the text back rather than losing it, but only into a box still
          // empty: by now the next prompt may already be part-typed, and
          // restoring over that would repeat the bug this replaced. The
          // attachments stay in the tray untouched either way — the upload
          // itself succeeded independently of this send, and is still there
          // to pair with a retry.
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
  //
  // Worded per status rather than off `busy` alone: 'queued' has no turn
  // running yet (saying so was the old bug — it read as a machine-wide block
  // rather than this session's own queue), and both wordings lead with "this
  // session" so neither can be misread as a global stall.
  const queueLine = [
    busy && t(data.status === 'running' ? 'sessions.willQueueRunning' : 'sessions.willQueueQueued'),
    data.pendingPrompts > 0 && t('sessions.pendingPrompts', { count: data.pendingPrompts }),
  ]
    .filter(Boolean)
    .join(' · ')

  const removeUpload = (upload: AttachmentUpload) => {
    if (upload.status === 'error') {
      uploads.dismiss(upload.id)
      return
    }
    if (upload.serverFile) {
      deleteFile.mutate(
        { path: { id: sessionId, fileId: upload.serverFile.id } },
        { onSuccess: () => uploads.dismiss(upload.id) },
      )
    }
  }

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
          {/* Only sessions handed off from an idea have anywhere to link back
              to; a session created directly has no `ideaId` and shows nothing
              here. Placed ahead of Stop/the menu so navigation reads to the
              left of the destructive and overflow actions. */}
          {data.ideaId && (
            <Button asChild variant="secondary" size="sm">
              <Link
                to="/projects/$projectId/ideas/$ideaId"
                params={{ projectId: data.projectId, ideaId: data.ideaId }}
              >
                {t('sessions.backToIdea')}
              </Link>
            </Button>
          )}
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

      <div
        className={styles.scroll}
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {messages.isPending ? (
          <Spinner label={t('common.loading')} block />
        ) : messages.isError ? (
          // Distinct from an empty transcript: a rejected initial page (the
          // boundary validator in use-sessions.ts rejecting a malformed
          // envelope, or any other failure) must not render as though the
          // session simply has nothing in it yet.
          <Alert tone="danger">
            {apiErrorMessage(messages.error, t('sessions.transcript.loadFailed'))}
          </Alert>
        ) : (
          <div>
            {messages.hasPreviousPage && (
              <>
                <div ref={setSentinelNode} className={styles.olderSentinel} />
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
              </>
            )}
            <Transcript messages={messages.messages} sessionId={sessionId} />
          </div>
        )}
      </div>

      <Composer
        value={text}
        onChange={setText}
        onSubmit={submit}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. A prompt is usually one
          // line, and reaching for the mouse for every send is worse.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        sending={send.isPending}
        canSend={!send.isPending && text.trim().length > 0 && uploads.pendingCount === 0}
        orchestratorMissing={!data.orchestrator}
        queueLine={queueLine}
        error={error}
        attachments={{
          uploads: uploads.uploads,
          usage: files.data?.usage,
          usagePending: files.isPending,
          usageError: files.isError ? files.error : undefined,
          pendingCount: uploads.pendingCount,
          onAttach: uploads.attach,
          onCancel: uploads.cancel,
          onRemove: removeUpload,
        }}
      />
    </div>
  )
}
