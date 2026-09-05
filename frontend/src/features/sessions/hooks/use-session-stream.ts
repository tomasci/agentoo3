import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getApiSessionsIdQueryKey } from '@/shared/api/generated/hooks/useGetApiSessionsId'
import { appendStreamedMessage, isFetchingOlderPage, newestCachedSeq } from '../lib/message-cache'
import type { SessionMessage } from './use-sessions'

/**
 * Live transcript, merged into the same cache the initial fetch fills.
 *
 * The stream is not a second source of truth. Every event names the `seq` it
 * carries, and appending is a merge keyed on that (message-cache.ts owns the
 * merge and the cache shape both), so a message that arrives twice — replayed
 * on reconnect, or racing the initial fetch — lands once.
 *
 * EventSource reconnects on its own, but it always reconnects to the same URL,
 * which would replay from the beginning. So the connection is rebuilt manually
 * from the last seq seen, and the browser's own retry is turned off by closing
 * the source on error.
 *
 * `enabled` gates the connection on the messages query's own `isSuccess`
 * (the caller passes that in): opening the stream before the REST snapshot has
 * landed left nothing cached to seed `lastSeq` from, below, so the backend's
 * `after=-1` replayed every message in the session down the stream — a second
 * full download of a long transcript, appended one `setQueryData` at a time.
 */
export function useSessionStream(sessionId: string, enabled = true) {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  // Read inside the effect without making it a dependency: a changing seq must
  // not tear the connection down and rebuild it on every message.
  const lastSeq = useRef(-1)
  // Arrivals since the last flush. A ref, not state: a burst of messages in a
  // single animation frame must not cost a render per message to collect.
  const buffer = useRef<SessionMessage[]>([])

  useEffect(() => {
    if (!enabled) return
    const sessionKey = getApiSessionsIdQueryKey({ path: { id: sessionId } })

    // Seeded from whatever pagination has already cached — message-cache.ts
    // owns what "cached" means (which page, which shape), so this hook only
    // ever has to ask it for the number. The caller gates `enabled` on the
    // messages query's own `isSuccess`, so by the time this runs there is
    // normally something cached, and asking the stream to replay all of it
    // again is exactly the bug this hook exists to avoid. Falls back to -1
    // (replay everything) only when the cache is genuinely empty.
    lastSeq.current = newestCachedSeq(queryClient, sessionId)

    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let frame: number | null = null

    const flush = () => {
      frame = null
      if (buffer.current.length === 0) return
      if (isFetchingOlderPage(queryClient, sessionId)) {
        // A `loadOlder` fetch snapshots `state.data.pages` the instant it
        // starts and overwrites the whole `InfiniteData` with that snapshot
        // on resolution (query-core's `addToStart`), so a write landing here
        // now would just be discarded when it resolves — leave the batch in
        // `buffer.current` untouched and check again next frame. Once the
        // fetch clears, that flush merges onto whatever `loadOlder` landed
        // instead of racing it. `appendStreamedMessage` (message-cache.ts)
        // guards against this too, so skipping the write here is purely
        // about coalescing every arrival from a slow fetch into the one
        // write that follows it, not the last line of defence.
        frame = requestAnimationFrame(flush)
        return
      }
      const batch = buffer.current
      buffer.current = []
      appendStreamedMessage(queryClient, sessionId, batch)
    }

    const append = (message: SessionMessage) => {
      lastSeq.current = Math.max(lastSeq.current, message.seq)
      buffer.current.push(message)
      // One merge per frame, not one per message: a running agent emits in
      // bursts, and each used to be its own `setQueryData` — its own full
      // `buildTranscript()` over every message in the session.
      if (frame === null) frame = requestAnimationFrame(flush)
    }

    const connect = () => {
      if (closed) return
      const after = lastSeq.current
      source = new EventSource(`/api/sessions/${sessionId}/events?after=${after}`)

      source.addEventListener('open', () => setConnected(true))

      source.addEventListener('message', (event) => {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as {
          message?: SessionMessage
        }
        if (parsed.message) append(parsed.message)
      })

      source.addEventListener('status', () => {
        // The session row carries status, cost and the pending count; refetch
        // rather than patch, so one shape is not maintained in two places.
        void queryClient.invalidateQueries({ queryKey: sessionKey })
      })

      source.addEventListener('error', () => {
        setConnected(false)
        source?.close()
        // Reconnect ourselves, from where we left off. `buffer`/`frame` are
        // deliberately untouched here: they belong to this effect run, not to
        // this one connection, so anything still queued keeps its place and
        // flushes on the next animation frame regardless of which connection
        // it arrived on.
        if (!closed) retry = setTimeout(connect, 3000)
      })
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      // Cancel the scheduled frame and flush synchronously rather than
      // leaving it to fire on its own: `lastSeq.current` has already moved
      // past anything still sitting in `buffer.current` (a future connection
      // will not ask the backend for it again), so it has to land in the
      // cache now or it is gone. Unless a `loadOlder` fetch is still in
      // flight: writing now would only be discarded when it resolves (the
      // same race `flush` defers above), and no later frame from this effect
      // will ever run to retry it once torn down — so there is nothing a
      // write here would preserve. Dropping here is deliberate, not an
      // oversight: `appendStreamedMessage` would otherwise queue a retry that
      // outlives the component and reseeds a session nobody is looking at
      // anymore once the fetch does settle.
      if (frame !== null) cancelAnimationFrame(frame)
      if (!isFetchingOlderPage(queryClient, sessionId)) flush()
      source?.close()
      setConnected(false)
    }
  }, [sessionId, enabled, queryClient])

  return { connected }
}
