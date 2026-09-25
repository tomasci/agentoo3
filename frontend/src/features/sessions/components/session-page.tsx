import { Link } from '@tanstack/react-router'
import { OctagonXIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditorStop } from '@/features/editor'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ActionsMenu, Code, Loading, StatusBadge, StatusDot, toast } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Spinner } from '@/shared/ui/spinner'
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
import { Composer } from './composer'
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
 * for a prepend (Chrome, Firefox), this delta comes out zero and the
 * caller's write is a no-op. That is what makes it safe to reapply — the
 * correction below, and `onScroll`'s own re-recording of it while a fetch is
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

/**
 * Whether the sentinel is still inside the zone the IntersectionObserver
 * below watches — one viewport height above the container's own visible top
 * edge, mirroring its `rootMargin` (the two are kept in sync by hand; see
 * that effect's own comment). A page that lands while this is still true
 * would otherwise never be asked about again: an IntersectionObserver only
 * fires on a *transition* into intersection, and a normal-speed scroll
 * reaching the top before a fetch lands, or a page that adds a lot of
 * history but only a little rendered height (a long page collapsing into one
 * grouped, collapsed task row), both leave the sentinel exactly where it
 * already was.
 */
function inLoadZone(sentinel: HTMLElement, scroller: HTMLElement): boolean {
  return offsetOf(sentinel, scroller) >= -scroller.clientHeight
}

// `projectId` stays in the prop type — the route still supplies it — but is no
// longer destructured: the only thing that read it was the back-to-list button.
export function SessionPage({ sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const messages = useSessionMessages(sessionId)
  const send = useSendMessage(sessionId)
  const interrupt = useInterruptSession(sessionId)
  // Needs `projectId` too, unlike every other hook here, which is why it is
  // declared with a fallback rather than after the `session.data` guard
  // below: hooks cannot be called conditionally, and by the time the "Stop
  // editor" menu item that actually calls `mutate` can render at all,
  // `session.data` — and so this hook's real `projectId` — is guaranteed to
  // be in.
  const stopEditor = useEditorStop(session.data?.projectId ?? '', sessionId)
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
  // Guards `requestOlder` against re-entry — not only while the fetch itself
  // is in flight, but through the gap after it resolves and before React
  // commits the page it produced. `.then()` below only opens this back up for
  // a settle nothing is coming to commit (an error, or a page that made no
  // progress); a settle that DID make progress leaves it closed until the
  // `oldestSeq` layout effect actually processes that commit. Without that,
  // a fresh IntersectionObserver entry — or anything else automatic —
  // landing in that gap could issue a second request before the first one's
  // own `anchor`/`lastRequestedBefore` have even been read, overwriting both
  // out from under a correction that has not happened yet. `messages.
  // isLoadingOlder` (react-query's own flag) is no substitute: it flips at
  // the same "promise resolved" instant this ref used to, one render before
  // the commit this one now waits for.
  const loadingOlder = useRef(false)
  // The row `requestOlder` picked to anchor a prepend on, and the viewport
  // offset it had at that moment (see `pickAnchor`/`offsetOf` above). `null`
  // means "no prepend to compensate for" — the ordinary case of every render
  // that is not that one. Kept live by `onScroll` below while a fetch is in
  // flight, so scrolling during the fetch is preserved rather than fought.
  const anchor = useRef<{ el: HTMLElement; offset: number } | null>(null)
  // The `before` cursor of the most recent request-older fetch this
  // component has issued and not yet fully accounted for — `undefined`
  // whenever there is none. Closes two different bugs at once:
  //
  // Structural progress (a fetch chain has to end on its own, no matter what
  // the backend does): an *automatic* continuation below may only fire with
  // a candidate cursor strictly older than this one, so a chain is bounded
  // by how far `seq` can still fall rather than by trusting any one fetch to
  // eventually admit "no more" honestly.
  //
  // Whose settle this is: the `oldestSeq`-keyed layout effect below fires for
  // *any* reason `oldestSeq` changes identity — the initial page landing, a
  // session switch (see the layout effect further down that clears this on
  // `sessionId`), or a genuine older-page fetch settling — and only the last
  // of those has anything here to correct or recheck. Left `undefined`
  // except while such a fetch is outstanding or has just landed, this is
  // also what that effect reads to tell the three apart.
  const lastRequestedBefore = useRef<number | undefined>(undefined)
  // Bumped every time `requestOlder` actually dispatches a fetch (captured
  // by that call's own closure), and once more by the session-switch effect
  // below on every `sessionId` change. Its `.then()` compares its own
  // capture against the live value before touching `loadingOlder`/`anchor`/
  // `lastRequestedBefore` — a fetch a *later* call has already superseded
  // (the geometric re-check firing again before this one's callback runs, or
  // a session switch abandoning it outright) has nothing current left to say
  // about any of them, and touching them anyway is exactly how one race would
  // clobber a request nothing here is waiting on any more. An unmount needs
  // no entry here of its own: nothing left running after one can still read
  // these refs, and any future remount starts every one of them, this
  // counter included, fresh at its own initial value.
  const olderRequestId = useRef(0)
  // The `before` cursor of the most recent settle that made *no* progress —
  // `undefined` once the chain has moved past it. An automatic trigger
  // (the sentinel's own observer, or the continuation the `oldestSeq` effect
  // below issues on itself) may never repeat this exact cursor: nothing about
  // *why* it would work this time has changed, and a plain rescroll back
  // into the zone is not a reason to believe otherwise. A manual click is
  // read as a person deciding to try again anyway, and is not gated on this.
  const noProgressCursor = useRef<number | undefined>(undefined)
  // The observer the effect below builds, kept live so a settle that made
  // progress can force it to look at the sentinel again — see that effect's
  // own comment on why a plain transition-only observer is not enough on its
  // own. `null` outside the window the sentinel is actually mounted in.
  const observerRef = useRef<IntersectionObserver | null>(null)
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

  const clearInteractionTimer = () => {
    if (interactionTimer.current !== null) {
      clearTimeout(interactionTimer.current)
      interactionTimer.current = null
    }
  }

  // Shared by both places that pin the transcript to the bottom — the effect
  // below, and the interaction timer's own catch-up once a gesture ends. A
  // single write, not a loop: every row renders at its real height as soon
  // as it commits (see transcript.tsx), so there is nothing left that could
  // still be resolving a frame later for a second pass to catch.
  const pinToBottom = () => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight - el.clientHeight
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
      // off-screen — one write here, not an ongoing follow: the pin effect
      // below declined to run while this was armed, and nothing re-arms it
      // except a genuine new arrival.
      if (pinned.current) pinToBottom()
    }, 200)
  }

  // Fetches one older page, anchoring the scroll on `pickAnchor` before it
  // lands. `startedAtSeq` is captured now, synchronously, rather than read
  // from `oldestSeq` inside `.then()` below: react-query has already written
  // that fetch's result into the cache by the time its promise settles, but
  // React may not have re-rendered from it yet, so `oldestSeq` read there
  // could already be one fetch ahead of the value this call actually needs —
  // "what was oldest when *this* fetch started".
  const requestOlder = (auto = true) => {
    const el = scroller.current
    // `hasPreviousPage`, not `hasOlder`: the latter is only ever the *first*
    // loaded page's own flag, so a page that ever comes back empty while
    // still claiming `hasOlder: true` would leave this guard permanently
    // open on a button that can no longer fetch anything (`getPreviousPageParam`
    // has nothing to anchor on and returns `undefined` forever). `hasPreviousPage`
    // is derived from that same function, so it is false in exactly the cases
    // where fetching again would be a no-op.
    if (!el || loadingOlder.current || !messages.hasPreviousPage) return
    // See `noProgressCursor`'s own comment: every automatic caller (the
    // sentinel's observer defaults `auto` to `true`; so does the continuation
    // below) is bound by it, the button's `onClick` is the one call site that
    // passes `false`.
    if (auto && oldestSeq !== undefined && oldestSeq === noProgressCursor.current) return
    loadingOlder.current = true
    anchor.current = pickAnchor(el)
    // A prepend is a scrollback read, never "stay pinned to the bottom" — even
    // a short first page that fits the whole viewport reads as `pinned` under
    // the at-bottom heuristic below, and without this it would get yanked
    // back down the moment older history landed above it. The `oldestSeq`
    // layout effect below recomputes it from the geometry actually committed
    // once this fetch lands, so a reader who never left the bottom in the
    // first place gets it back rather than staying stranded off it.
    pinned.current = false
    const startedAtSeq = oldestSeq
    lastRequestedBefore.current = startedAtSeq
    const myRequestId = ++olderRequestId.current
    void messages.loadOlder().then((result) => {
      // A later call — the geometric re-check below, most likely, or a
      // session switch — has already moved on from this fetch. Its own
      // `.then()` (or the session-switch effect) already owns
      // `loadingOlder`/`anchor`/`lastRequestedBefore` now; touching any of
      // them here would race whichever of those actually is current.
      if (olderRequestId.current !== myRequestId) return
      // The button/alert stay up as the manual retry — automatically
      // retrying a fetch that just failed is exactly the loop "must not
      // stall" did not ask for.
      if (result.isFetchPreviousPageError) {
        loadingOlder.current = false
        anchor.current = null
        lastRequestedBefore.current = undefined
        return
      }
      // `result.data` is `select`'s own flattened shape (`selectMessages` in
      // use-sessions.ts), so its first message's `seq` already *is* the
      // post-fetch `oldestSeq` — read from the settled fetch's own result
      // rather than from `messages` in this closure, which is not
      // guaranteed fresh here (see this function's own comment above).
      if (result.data?.messages[0]?.seq === startedAtSeq) {
        // Nothing was prepended — an emptied page, most likely, while
        // `hasPreviousPage` still claimed more (a cancelled fetch resolving
        // with the data it started with, unchanged, lands here too — it is
        // no different from an emptied page as far as "did this move
        // anything" is concerned). `oldestSeq` never moved, so the layout
        // effect below never runs to pick this up: no correction is due, and
        // no commit is coming to close the guard for, which makes this the
        // one place left to close it. This is where the chain ends instead
        // of asking again with the very same cursor — which is exactly the
        // loop that used to grow without bound.
        loadingOlder.current = false
        anchor.current = null
        lastRequestedBefore.current = undefined
        noProgressCursor.current = startedAtSeq
        return
      }
      // Progress made: a commit is coming, so `loadingOlder` is left closed
      // rather than cleared here — see its own comment for why the instant a
      // promise resolves is already too early. `lastRequestedBefore` is left
      // at `startedAtSeq` for the `oldestSeq` layout effect below to compare
      // its own candidate continuation against, and that same effect is what
      // finally reopens `loadingOlder` once it has actually processed this
      // commit — that effect, not this callback, is what decides whether the
      // chain goes on. `noProgressCursor` is cleared rather than left stale:
      // `oldestSeq` has moved past whatever it held, so it would never have
      // compared equal again regardless, but a stale value here is a trap
      // for the next reader of this code, not for this component.
      noProgressCursor.current = undefined
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

  // `rootMargin` starts the fetch a full viewport height before the sentinel
  // is actually on screen. 300px used to be the margin, and a normal scroll
  // reaches the top well before a fetch that far out can land, which is what
  // left the reader staring at the button. An IntersectionObserver only fires
  // on a *transition* into intersection, so bouncing at a top already reached
  // (iOS rubber-band overscroll) cannot re-fire it — that re-arm rule is why
  // no other threshold is needed, and it is also why a page settling while
  // the sentinel is *already* inside this margin never gets a second
  // callback of its own: the geometric re-check in the `oldestSeq` effect
  // below is what covers that case, using the exact same margin
  // (`inLoadZone`) so the two never disagree about what "in the zone" means.
  // The button stays up as the affordance for a failed fetch (no automatic
  // retry there) and as a fallback should this observer ever not fire.
  // Depends only on `sentinelNode`'s own identity, not `messages.hasPreviousPage`
  // directly: the sentinel unmounts (node becomes `null`) exactly when that
  // flag does, so the node's own transitions already carry it.
  useEffect(() => {
    const root = scroller.current
    if (!sentinelNode || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        // The *last* entry, not the first: a batch can carry more than one
        // for the same target when the browser has no native scroll
        // anchoring of its own (iOS Safari) to smooth a page's arrival over —
        // the re-observe below can hand back an "outside" entry for the
        // instant it ran, immediately followed, in the same callback, by the
        // very next frame's "inside" once the reader's own scroll carried the
        // sentinel back in. Reading only the first would act on a state that
        // was already stale by the time this callback ran at all.
        const entry = entries[entries.length - 1]
        if (entry?.isIntersecting) requestOlderRef.current()
      },
      { root, rootMargin: '100% 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinelNode)
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [sentinelNode])

  // `SessionRoute` renders this component with no `key` (app/project-routes.tsx),
  // so navigating from one session to another reuses this exact instance and
  // every ref above along with it. Left alone, a request-older fetch still in
  // flight for the *old* session at the moment of that switch would settle
  // afterwards and be read by the very next render's `oldestSeq`-keyed layout
  // effect as if it were this (new) session's own settle — the same
  // initial-load misfire that effect's own comment guards against, just
  // reached through a different door. Bumping `olderRequestId` makes that
  // stale fetch's own `.then()` a no-op the moment it does settle, rather
  // than reading refs this reset already moved on from (or, worse, writing
  // to them out from under whatever request the new session goes on to make
  // of its own); the rest of this clears what a no-op `.then()` would
  // otherwise have left behind, giving the newly-opened session the same
  // clean defaults a first mount would have had.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not a value read inside
  useLayoutEffect(() => {
    anchor.current = null
    loadingOlder.current = false
    lastRequestedBefore.current = undefined
    noProgressCursor.current = undefined
    pinned.current = true
    olderRequestId.current++
  }, [sessionId])

  // Applies the prepend correction recorded in `anchor.current`, then decides
  // whether the chain goes on: this is the one place a `requestOlder` chain
  // actually continues itself (`requestOlder`'s own `.then()` above only ever
  // ends one).
  //
  // Fires for three different reasons `oldestSeq` can change identity — the
  // initial page landing, a session switch, or a genuine older-page fetch
  // settling — and only the last of those has anything here to correct or
  // recheck. `lastRequestedBefore.current` is what tells them apart: it is
  // `undefined` for the first two (nothing has called `requestOlder` yet for
  // *this* session — the layout effect above resets it on every `sessionId`
  // change), and holds the settled fetch's own cursor for the third.
  // biome-ignore lint/correctness/useExhaustiveDependencies: oldestSeq is the trigger, not a value read inside
  useLayoutEffect(() => {
    const el = scroller.current
    const picked = anchor.current
    anchor.current = null
    if (el && picked?.el.isConnected) {
      // Inserting older messages above the viewport pushes everything
      // already on screen down; reassigning `scrollTop` here rather than
      // trusting the browser's own scroll anchoring, which iOS Safari does
      // not implement at all. This is a no-op wherever the browser already
      // anchored (Chrome, Firefox): the anchor row's offset already equals
      // `picked.offset`.
      el.scrollTop += offsetOf(picked.el, el) - picked.offset
    }
    // The anchor row being gone rather than merely pushed down — an older
    // page restructured it, see `pickAnchor`'s own comment — leaves nothing
    // here able to say by how much the reader's position actually moved, so
    // the branch above simply does not run rather than guess.
    const requestedBefore = lastRequestedBefore.current
    if (!el || requestedBefore === undefined) return
    // This settle is spoken for from here on, regardless of whether
    // `requestOlder`'s own `.then()` has actually run yet — query-core
    // resolves that promise on its own schedule, not ordered against React's
    // commit of the very state change this effect is reacting to. Clearing
    // the guard here too is what keeps the continuation just below from
    // tripping over a `.then()` that simply hasn't caught up yet.
    loadingOlder.current = false
    lastRequestedBefore.current = undefined
    // The reader may never have left the bottom at all — a short first page
    // auto-loading more before they have touched the scrollbar, say (see
    // `requestOlder`'s own comment on why this is not decided there).
    // Recomputed from the geometry the correction above just committed, not
    // carried over from whatever `requestOlder` set it to when the fetch
    // started.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Forces the browser to redeliver an initial entry for the sentinel at
    // its own next rendering update, evaluated against wherever the reader
    // has actually scrolled to by then — not the geometry this effect just
    // committed. A page landing inside a long commit frame can push the
    // sentinel just outside `inLoadZone` at the exact instant the check below
    // runs; if the reader's own wheel or fling carries it back inside before
    // the browser's next update, a plain observer never saw an "outside"
    // state to transition *from* and has nothing to call back about — this
    // is what makes it look again anyway, rather than trusting a transition
    // that may never come. Skipped once history is exhausted: nothing is
    // left to watch, and the sentinel is on its way out of the tree in this
    // same commit.
    if (messages.hasPreviousPage && observerRef.current && sentinelNode) {
      observerRef.current.unobserve(sentinelNode)
      observerRef.current.observe(sentinelNode)
    }
    // What just landed can leave the sentinel still inside the load zone: a
    // page of a hundred messages often collapses into very little rendered
    // height (a grouped, collapsed task row), or an ordinary scroll simply
    // outran the fetch. An IntersectionObserver only fires on a *transition*
    // into intersection, so nothing else here will ever ask again on its
    // own; this asks again itself, against the geometry just committed
    // above, instead of waiting on a scroll event that may never come.
    //
    // `oldestSeq < requestedBefore`, not just "did it change": the structural
    // half of not looping forever (`lastRequestedBefore`'s own comment
    // above) — a continuation only ever fires with a cursor strictly older
    // than the one that was just requested, so this chain is bounded by how
    // far `seq` can still fall no matter what a page claims about `hasOlder`.
    if (
      messages.hasPreviousPage &&
      sentinelNode &&
      inLoadZone(sentinelNode, el) &&
      oldestSeq !== undefined &&
      oldestSeq < requestedBefore
    ) {
      requestOlder()
    }
  }, [oldestSeq])

  // Keeps the transcript pinned to the bottom while its content changes. One
  // write is enough now: every row renders at its real height as soon as it
  // commits (see transcript.tsx — there is no `content-visibility` placeholder
  // left to resolve afterwards), so there is nothing left for a follow-up
  // pass to catch the way there was when this held the position open over
  // several frames.
  //
  // Keyed on `messages.messages`' own identity, not a ResizeObserver on the
  // rendered content: `mergeSessionMessages`/`selectMessages`
  // (lib/message-cache.ts, hooks/use-sessions.ts) hand back the exact same
  // array reference for an arrival that changed nothing, so this never fires
  // for a render that has nothing new for it. Given up deliberately along
  // with the ResizeObserver it replaced: a row that grows *without* a new
  // message arriving — a running task's progress note updating in place — is
  // no longer followed. Re-adding that would mean re-adding the
  // write-triggers-resize-triggers-write loop that made the phone case
  // unreasonable in the first place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinToBottom is a fresh closure every render (it closes only over refs, so it is never stale); messages.messages is the one thing that should retrigger this
  useLayoutEffect(() => {
    if (!scroller.current || !pinned.current || interacting.current) return
    pinToBottom()
  }, [messages.messages])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clearInteractionTimer is a fresh closure every render (it closes only over the interactionTimer ref); this runs once, on unmount, regardless
  useEffect(() => {
    return () => clearInteractionTimer()
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

  // Full-bleed route (see root-layout.tsx's `isFullBleedPath`): the shell
  // hands this page zero padding of its own, so every render path — not just
  // the loaded one below — has to supply the `p-4 lg:p-6` an ordinary page
  // gets for free, or its content sits flush against the panel's edges.
  if (session.isPending) {
    return (
      <div className="p-4 lg:p-6">
        <Loading label={t('common.loading')} block />
      </div>
    )
  }
  if (session.isError || !session.data) {
    return (
      <div className="p-4 lg:p-6">
        <Alert variant="destructive">
          <OctagonXIcon />
          <AlertDescription>
            {apiErrorMessage(session.error, t('sessions.loadFailed'))}
          </AlertDescription>
        </Alert>
      </div>
    )
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
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 lg:p-6">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-2">
        <StatusBadge tone={STATUS_TONE[data.status]}>
          {t(`sessions.status.${data.status}`)}
        </StatusBadge>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
        <div className="order-1 flex basis-full flex-wrap items-center gap-2 overflow-hidden text-xs text-muted-foreground md:order-none md:basis-auto md:flex-nowrap md:text-sm">
          {/* Set-once configuration, not live status — it steps aside below
              `md` so the row has room for what actually changes. */}
          {data.orchestrator && <span className="hidden md:inline">{data.orchestrator}</span>}
          {data.branch && <Code>{data.branch}</Code>}
          {data.totalCostUsd > 0 && <span>${data.totalCostUsd.toFixed(4)}</span>}
          <span className="order-first inline-flex items-center gap-2 whitespace-nowrap md:order-none">
            <StatusDot tone={connected ? 'accent' : 'neutral'} />
            {connected ? t('sessions.live') : t('sessions.reconnecting')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Only sessions handed off from an idea have anywhere to link back
              to; a session created directly has no `ideaId` and shows nothing
              here. Placed ahead of Stop/the menu so navigation reads to the
              left of the destructive and overflow actions. Styled through
              `buttonVariants` rather than `Button render={<Link/>}` — see the
              track's own rule on link-as-button. */}
          {data.ideaId && (
            <Link
              to="/projects/$projectId/ideas/$ideaId"
              params={{ projectId: data.projectId, ideaId: data.ideaId }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('sessions.backToIdea')}
            </Link>
          )}
          {/* Only an isolated session has a worktree of its own to run docker
              against — a shared-checkout session has none, and the backend
              400s on it (features/docker/scope.ts) — so the link is never
              offered for one at all. */}
          {data.isolated && (
            <Link
              to="/projects/$projectId/sessions/$sessionId/docker"
              params={{ projectId: data.projectId, sessionId: data.id }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('sessions.docker')}
            </Link>
          )}
          {/* Same gate as Docker above, for the same reason: a code-server
              container runs against this session's own worktree
              (features/editor/service.ts resolves scope the same way
              features/docker/scope.ts does), which a shared-checkout session
              does not have.

              A real anchor via `target`, not a click handler that calls
              `window.open`: the latter needs a popup blocker's blessing and
              drops modifier clicks (middle-click, cmd/ctrl-click) on the
              floor, where a plain `<a target="_blank">` — which is all
              `Link` renders once `target` is set — never needs permission
              and honours them for free. The editor launcher this opens
              (features/editor/components/editor-launcher.tsx) renders with
              no app shell around it at all, which is also why it has to be a
              *new* tab rather than an in-app navigation: this tab's own
              workspace state must stay exactly as the reader left it. */}
          {data.isolated && (
            <Link
              to="/projects/$projectId/sessions/$sessionId/editor"
              params={{ projectId: data.projectId, sessionId: data.id }}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('sessions.editor')}
            </Link>
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
              // Same isolated-only gate as the Editor link above: a
              // shared-checkout session has no editor container to stop.
              // Lives in the overflow menu, not beside the link, because
              // stopping is the rare path — the container idles itself out
              // on its own, and the common way to end a session is just to
              // close its tab. No polling here afterwards: `stop` is
              // idempotent (features/editor's own contract), so there is
              // nothing this page needs to keep watching for.
              ...(data.isolated
                ? [
                    {
                      id: 'stop-editor',
                      label: t('sessions.stopEditor'),
                      disabled: stopEditor.isPending,
                      onSelect: () => {
                        stopEditor.mutate(
                          { path: { id: data.projectId, sessionId: data.id } },
                          {
                            onSuccess: () =>
                              toast.add({ title: t('sessions.editorStopped'), type: 'success' }),
                            onError: (e) =>
                              toast.add({
                                title: apiErrorMessage(e, t('editor.errors.stopFailed')),
                                type: 'error',
                              }),
                          },
                        )
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>

      {data.lastError && (
        <Alert variant="destructive" className="shrink-0">
          <OctagonXIcon />
          <AlertDescription>{data.lastError}</AlertDescription>
        </Alert>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pr-1"
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {messages.isPending ? (
          <Loading label={t('common.loading')} block />
        ) : messages.isError ? (
          // Distinct from an empty transcript: a rejected initial page (the
          // boundary validator in use-sessions.ts rejecting a malformed
          // envelope, or any other failure) must not render as though the
          // session simply has nothing in it yet.
          <Alert variant="destructive">
            <OctagonXIcon />
            <AlertDescription>
              {apiErrorMessage(messages.error, t('sessions.transcript.loadFailed'))}
            </AlertDescription>
          </Alert>
        ) : (
          <div>
            {messages.hasPreviousPage && (
              <>
                <div ref={setSentinelNode} className="h-0" />
                <div className="flex flex-col items-center gap-2 pb-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => requestOlder(false)}
                    disabled={messages.isLoadingOlder}
                  >
                    {messages.isLoadingOlder && (
                      <Spinner data-icon="inline-start" aria-hidden="true" />
                    )}
                    {messages.isLoadingOlder
                      ? t('sessions.transcript.loadingOlder')
                      : t('sessions.transcript.loadOlder')}
                  </Button>
                  {messages.isLoadOlderError && (
                    <Alert variant="destructive">
                      <OctagonXIcon />
                      <AlertDescription>
                        {t('sessions.transcript.loadOlderFailed')}
                      </AlertDescription>
                    </Alert>
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
