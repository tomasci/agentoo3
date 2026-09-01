import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getApiSessionsIdQueryKey } from '@/shared/api/generated/hooks/useGetApiSessionsId'
import { getApiSessionsIdMessagesQueryKey } from '@/shared/api/generated/hooks/useGetApiSessionsIdMessages'
import type { SessionMessage } from './use-sessions'

/**
 * Live transcript, merged into the same cache the initial fetch fills.
 *
 * The stream is not a second source of truth. Every event names the `seq` it
 * carries, and appending is a merge keyed on that, so a message that arrives
 * twice — replayed on reconnect, or racing the initial fetch — lands once.
 *
 * EventSource reconnects on its own, but it always reconnects to the same URL,
 * which would replay from the beginning. So the connection is rebuilt manually
 * from the last seq seen, and the browser's own retry is turned off by closing
 * the source on error.
 */
export function useSessionStream(sessionId: string, enabled = true) {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  // Read inside the effect without making it a dependency: a changing seq must
  // not tear the connection down and rebuild it on every message.
  const lastSeq = useRef(-1)

  useEffect(() => {
    if (!enabled) return
    lastSeq.current = -1
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const messagesKey = getApiSessionsIdMessagesQueryKey({ path: { id: sessionId } })
    const sessionKey = getApiSessionsIdQueryKey({ path: { id: sessionId } })

    const append = (message: SessionMessage) => {
      lastSeq.current = Math.max(lastSeq.current, message.seq)
      queryClient.setQueryData<SessionMessage[]>(messagesKey, (existing) => {
        const list = existing ?? []
        const at = list.findIndex((m) => m.seq === message.seq)
        if (at !== -1) {
          const next = list.slice()
          next[at] = message
          return next
        }
        // Append, then sort only when it actually arrived out of order.
        const next = [...list, message]
        const previous = next[next.length - 2]
        return previous && previous.seq > message.seq ? next.sort((a, b) => a.seq - b.seq) : next
      })
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
        // Reconnect ourselves, from where we left off.
        if (!closed) retry = setTimeout(connect, 3000)
      })
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      source?.close()
      setConnected(false)
    }
  }, [sessionId, enabled, queryClient])

  return { connected }
}
