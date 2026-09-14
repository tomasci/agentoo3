import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { env } from '@/shared/config/env'
import { logger } from '@/shared/lib/logger'

export interface LogLine {
  kind: 'line'
  /** A local, monotonically increasing id — docker gives no seq cursor (only
   * `at`, which can repeat), so this is what a rendered list keys on. */
  id: number
  stream: 'stdout' | 'stderr'
  at: string | null
  text: string
}

/** The server dropped this many lines to keep up with a container outrunning
 * a slow reader — rendered inline, in order, so the gap is visible rather
 * than silently swallowed. */
export interface DroppedMarker {
  kind: 'dropped'
  id: number
  lines: number
}

export type LogEntry = LogLine | DroppedMarker

export interface LogEnded {
  reason: 'exited' | 'eof' | 'error' | 'closed'
  message: string | null
}

const logFrameSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  at: z.string().nullable(),
  text: z.string(),
})

const droppedFrameSchema = z.object({ lines: z.number() })

const endFrameSchema = z.object({
  reason: z.enum(['exited', 'eof', 'error', 'closed']),
  message: z.string().nullable(),
})

/** Boundary validation, same idiom as sessions/lib/streamed-message.ts: a
 * frame that fails to parse is dropped and logged, never thrown. */
function parseFrame<T>(schema: z.ZodType<T>, data: string, what: string): T | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    logger.warn(`Dropping a container log ${what} frame that was not valid JSON`, error)
    return undefined
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    logger.warn(`Dropping a malformed container log ${what} frame`, result.error.issues)
    return undefined
  }
  return result.data
}

// A container can print far more than a browser tab should hold onto; capped
// so a chatty one cannot grow this pane without bound.
const MAX_LINES = 2000

// The server caps concurrent log streams at 8 per API process and answers
// 429 over that cap — a fact `EventSource` cannot see (it exposes no status
// code), so a capped-out reconnect is indistinguishable from any other
// failure and must not be retried in a tight loop against a server that is
// already full. Backs off from 3s, doubling each further failure in a row,
// capped at 30s; a successful `open` resets it, since a live connection is
// proof the cap (or whatever else was wrong) has cleared.
const BASE_BACKOFF_MS = 3000
const MAX_BACKOFF_MS = 30_000

function capped(entries: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...entries, entry]
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
}

/**
 * Live logs for one container. Docker offers no seq cursor the way the
 * session transcript's own SSE does (use-session-stream.ts), only a
 * timestamp: a reconnect asks for `since=<at of the last line rendered>` and
 * drops any leading replayed line whose `at` is not after that cursor.
 * Duplicate lines are still possible and accepted — there is no way to tell
 * a genuine repeat apart from docker's own replay from the same instant, and
 * the alternative (dropping anything that merely matches an old timestamp)
 * would risk losing a real line that happened to share it.
 *
 * Reconnects with exponential backoff (`BASE_BACKOFF_MS` doubling to
 * `MAX_BACKOFF_MS`, reset on the next successful `open`) rather than
 * `use-session-stream.ts`'s fixed 3s retry: that stream reconnects to one
 * API process this app already trusts is there; this one reconnects against
 * an 8-per-process concurrent-stream cap that a busy dashboard can actually
 * hit, and `EventSource` cannot see the 429 that follows — a fixed interval
 * would re-request every 3s forever, indefinitely, against a server that is
 * already full.
 *
 * Only meant to be mounted while its log pane is actually open (the caller —
 * container-logs.tsx, inside a `Collapsible` — controls that by mounting):
 * the server caps concurrent log streams at 8 per API process, so holding one
 * open for every container regardless of whether anyone is looking at it
 * would starve the readers who are.
 */
export function useContainerLogs(
  projectId: string,
  containerId: string,
  sessionId?: string,
  tail = 200,
) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [connected, setConnected] = useState(false)
  // True only while a reconnect is scheduled after a failure — distinct from
  // plain "not connected yet" (the very first attempt, before its own
  // `open`), so a stalled stream reads differently from a quiet-but-fine one
  // or one that has simply not opened yet.
  const [reconnecting, setReconnecting] = useState(false)
  const [ended, setEnded] = useState<LogEnded | null>(null)
  const lastSeenAt = useRef<string | null>(null)
  const nextId = useRef(0)

  useEffect(() => {
    setEntries([])
    setEnded(null)
    setReconnecting(false)
    lastSeenAt.current = null
    nextId.current = 0

    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    // Effect-local, not a ref: nothing outside `connect`/the `error` handler
    // ever reads it, so there is no re-render it needs to survive other than
    // this closure's own.
    let backoff = BASE_BACKOFF_MS

    const connect = () => {
      if (closed) return
      const since = lastSeenAt.current
      const params = new URLSearchParams()
      if (since) params.set('since', since)
      else params.set('tail', String(tail))
      // Scopes the stream the same way the REST status/operation calls do —
      // omitted entirely for repo scope, never sent as an empty string.
      if (sessionId) params.set('sessionId', sessionId)

      source = new EventSource(
        `${env.apiUrl}/projects/${projectId}/docker/containers/${containerId}/logs?${params}`,
      )

      source.addEventListener('open', () => {
        setConnected(true)
        setReconnecting(false)
        backoff = BASE_BACKOFF_MS
      })

      source.addEventListener('log', (event) => {
        const line = parseFrame(logFrameSchema, (event as MessageEvent<string>).data, 'log')
        if (!line) return
        // On a reconnect, the server replays from (and including) `since` —
        // drop the leading overlap rather than show it twice.
        if (since && line.at && line.at <= since) return
        if (line.at) lastSeenAt.current = line.at
        const id = nextId.current++
        setEntries((prev) => capped(prev, { kind: 'line', id, ...line }))
      })

      source.addEventListener('dropped', (event) => {
        const dropped = parseFrame(
          droppedFrameSchema,
          (event as MessageEvent<string>).data,
          'dropped',
        )
        if (!dropped) return
        const id = nextId.current++
        setEntries((prev) => capped(prev, { kind: 'dropped', id, lines: dropped.lines }))
      })

      source.addEventListener('end', (event) => {
        const end = parseFrame(endFrameSchema, (event as MessageEvent<string>).data, 'end')
        // Terminal either way, even when the frame itself failed to parse —
        // the server has closed the stream, so there is nothing left to
        // reconnect for.
        closed = true
        source?.close()
        setConnected(false)
        setReconnecting(false)
        setEnded(end ?? { reason: 'closed', message: null })
      })

      source.addEventListener('error', () => {
        setConnected(false)
        source?.close()
        if (closed) return
        setReconnecting(true)
        retry = setTimeout(connect, backoff)
        // Grows for the *next* failure — this one's wait was already
        // scheduled above at the pre-doubling value.
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      })
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      source?.close()
      setConnected(false)
      setReconnecting(false)
    }
  }, [projectId, containerId, sessionId, tail])

  return { entries, connected, reconnecting, ended }
}
