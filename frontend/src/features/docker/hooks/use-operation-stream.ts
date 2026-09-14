import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { getApiProjectsIdDockerQueryKey } from '@/shared/api/generated/hooks/useGetApiProjectsIdDocker'
import { env } from '@/shared/config/env'
import { logger } from '@/shared/lib/logger'

export interface OperationOutputLine {
  seq: number
  stream: 'stdout' | 'stderr'
  text: string
  at: string
}

// Not the *generated* `DockerOperation` shape — an `operation` frame's job
// here is only ever to update `status`/`exitCode`/`error`, and validating
// against the full generated type would drop a legitimate frame the moment a
// field this hook never reads went missing or changed type on the backend
// (exactly what happened when `sessionId` was added to the generated type
// for worktree-scoped docker). `DockerOperation` below is inferred from this
// schema rather than imported from the generated client, so the state this
// hook holds can never be made to require a field this hook does not parse.
const operationFrameSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(['up', 'stop', 'restart', 'down']),
  services: z.array(z.string()),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export type DockerOperation = z.infer<typeof operationFrameSchema>

const outputFrameSchema = z.object({
  seq: z.int(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
  at: z.string(),
})

/** Parses one SSE frame's `data`, or logs and returns `undefined` — the same
 * boundary-validation idiom as sessions/lib/streamed-message.ts. */
function parseFrame<T>(schema: z.ZodType<T>, data: string, what: string): T | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    logger.warn(`Dropping a docker operation ${what} frame that was not valid JSON`, error)
    return undefined
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    logger.warn(`Dropping a malformed docker operation ${what} frame`, result.error.issues)
    return undefined
  }
  return result.data
}

// A `compose up --build` can print for minutes; capped so a chatty build
// cannot grow this pane without bound. Matches the container-logs cap
// (use-container-logs.ts) for the same reason.
const MAX_LINES = 2000

/**
 * Live output and status for one docker operation, over the SSE endpoint the
 * four mutations' 202 response points at. Modelled on
 * sessions/hooks/use-session-stream.ts: a manually-rebuilt connection (so a
 * reconnect resumes from `after=<lastSeq>` instead of replaying from the
 * start), the browser's own retry turned off by closing on `error`.
 *
 * Invalidates the project's `/docker` status query itself, right when the
 * `end` frame arrives, rather than handing the caller an `ended` flag to act
 * on from its own effect — `useQueryClient()`'s return value is the same
 * object across renders, so folding the invalidation in here needs no extra
 * dependency that would otherwise have to be a fresh callback identity from
 * the caller on every render.
 */
export function useOperationStream(projectId: string, operationId: string) {
  const queryClient = useQueryClient()
  const [operation, setOperation] = useState<DockerOperation | null>(null)
  const [lines, setLines] = useState<OperationOutputLine[]>([])
  const [connected, setConnected] = useState(false)
  const [ended, setEnded] = useState(false)
  const lastSeq = useRef(-1)

  useEffect(() => {
    setOperation(null)
    setLines([])
    setEnded(false)
    lastSeq.current = -1

    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const connect = () => {
      if (closed) return
      const after = lastSeq.current
      source = new EventSource(
        `${env.apiUrl}/projects/${projectId}/docker/operations/${operationId}/events?after=${after}`,
      )

      source.addEventListener('open', () => setConnected(true))

      source.addEventListener('operation', (event) => {
        const op = parseFrame(
          operationFrameSchema,
          (event as MessageEvent<string>).data,
          'operation',
        )
        if (op) setOperation(op)
      })

      source.addEventListener('output', (event) => {
        const line = parseFrame(outputFrameSchema, (event as MessageEvent<string>).data, 'output')
        if (!line) return
        lastSeq.current = Math.max(lastSeq.current, line.seq)
        setLines((prev) => {
          const next = [...prev, line]
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
        })
      })

      source.addEventListener('end', () => {
        // Terminal: the operation is done and the server has nothing more to
        // publish on this stream, so — unlike the `error` branch below —
        // this deliberately does not reconnect.
        closed = true
        source?.close()
        setConnected(false)
        setEnded(true)
        void queryClient.invalidateQueries({
          queryKey: getApiProjectsIdDockerQueryKey({ path: { id: projectId } }),
        })
      })

      source.addEventListener('error', () => {
        setConnected(false)
        source?.close()
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
  }, [projectId, operationId, queryClient])

  return { operation, lines, connected, ended }
}
