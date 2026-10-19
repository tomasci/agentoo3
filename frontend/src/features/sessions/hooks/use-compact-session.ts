import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { createSessionCompactionMutationOptions } from '@/shared/api/generated/hooks/useCreateSessionCompaction'
import { getApiProjectsIdSessionsQueryKey } from '@/shared/api/generated/hooks/useGetApiProjectsIdSessions'
import {
  getSessionCompactionQueryKey,
  getSessionCompactionQueryOptions,
} from '@/shared/api/generated/hooks/useGetSessionCompaction'
import { sessionCompactionStatusEnum } from '@/shared/api/generated/types/SessionCompaction'
import { toast } from '@/shared/components'

const COMPACTION_POLL_MS = 1500

/**
 * One click of "Compact session", from the POST to the end of the navigation
 * it leads to. Every variant carries the session it was started on, which is
 * what `useCompactSession` checks the live `sessionId` against.
 *
 * `opening` is the compaction having succeeded and the router not having
 * landed on the new session yet: still "in flight" as far as the buttons are
 * concerned, so a second click in that gap cannot start a second compaction.
 */
type Attempt =
  | { sessionId: string; phase: 'starting' }
  | { sessionId: string; phase: 'polling'; compactionId: string }
  | { sessionId: string; phase: 'opening' }
  | { sessionId: string; phase: 'failed'; message: string }

const isActive = (status: string | undefined) =>
  status === sessionCompactionStatusEnum.pending || status === sessionCompactionStatusEnum.running

/**
 * Compacts a session: the backend summarizes its conversation in a background
 * job and starts a new session from that summary (the original is never
 * touched). This starts the job, polls it, and on success opens the new
 * session; on failure it toasts the reason and says nothing more.
 *
 * Everything held here belongs to `sessionId`. `SessionRoute` renders
 * `SessionPage` with no `key`, so this hook instance outlives a session
 * switch; the attempt is dropped during render when the id changes (the
 * pattern React documents for "adjusting state when a prop changes") rather
 * than from an effect, because an effect would leave one render still showing
 * the previous session as "Compacting…", and because an attempt merely
 * *ignored* for another session would come back to life on navigating back.
 *
 * Nothing survives a reload or leaving the session: clicking again is the way
 * back in, and the backend answers that with the compaction already running
 * rather than starting a second one.
 */
export function useCompactSession(sessionId: string, projectId: string) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useMutation(createSessionCompactionMutationOptions())
  const [attempt, setAttempt] = useState<Attempt | null>(null)

  if (attempt !== null && attempt.sessionId !== sessionId) setAttempt(null)
  const mine = attempt !== null && attempt.sessionId === sessionId ? attempt : null

  // A response for a session the reader has since left must not be written
  // into the one they are on now. Assigned during render, like
  // `requestOlderRef` in session-page.tsx: nothing reads it until a callback
  // fires, well after this render has committed.
  const currentSessionId = useRef(sessionId)
  currentSessionId.current = sessionId

  const compactionId = mine?.phase === 'polling' ? mine.compactionId : null
  const compaction = useQuery({
    ...getSessionCompactionQueryOptions({
      path: { id: sessionId, compactionId: compactionId ?? '' },
    }),
    enabled: compactionId !== null,
    // Stops on a failed poll as well as on a settled compaction: a query
    // that errored still holds the last good `data` (`pending`), so keying on
    // that alone would poll a dead endpoint forever. The backend reports a
    // compaction whose worker died as `failed` once it is stale, so a healthy
    // poll always reaches a terminal status on its own.
    refetchInterval: (query) =>
      query.state.status !== 'error' && isActive(query.state.data?.status)
        ? COMPACTION_POLL_MS
        : false,
  })

  useEffect(() => {
    if (mine?.phase !== 'polling') return
    const failWith = (message: string) => {
      setAttempt({ sessionId, phase: 'failed', message })
      toast.add({ type: 'error', title: message })
    }
    const data = compaction.data
    if (data?.status === sessionCompactionStatusEnum.failed) {
      // `error` is a readable sentence the backend wrote for exactly this.
      failWith(data.error?.trim() || t('sessions.compact.failed'))
      return
    }
    if (data?.status === sessionCompactionStatusEnum.succeeded) {
      // Null again if the new session was deleted in the meantime — there is
      // nowhere to go, which is a failure from here, not a success.
      if (!data.resultSessionId) {
        failWith(t('sessions.compact.failed'))
        return
      }
      setAttempt({ sessionId, phase: 'opening' })
      void queryClient.invalidateQueries({
        queryKey: getApiProjectsIdSessionsQueryKey({ path: { id: projectId } }),
      })
      void navigate({
        to: '/projects/$projectId/sessions/$sessionId',
        params: { projectId, sessionId: data.resultSessionId },
      }).catch(() =>
        setAttempt((current) =>
          current?.sessionId === sessionId && current.phase === 'opening' ? null : current,
        ),
      )
      return
    }
    if (compaction.isError) {
      failWith(apiErrorMessage(compaction.error, t('sessions.compact.statusFailed')))
    }
  }, [
    mine,
    compaction.data,
    compaction.isError,
    compaction.error,
    sessionId,
    projectId,
    t,
    navigate,
    queryClient,
  ])

  const inFlight = mine !== null && mine.phase !== 'failed'

  const start = () => {
    if (inFlight) return
    setAttempt({ sessionId, phase: 'starting' })
    create.mutate(
      { path: { id: sessionId } },
      {
        onSuccess: (data) => {
          if (currentSessionId.current !== sessionId) return
          // Seeded, not left for the first poll to find: the row is already
          // in hand, and a fresh `success` write is also what clears an
          // error left over from an earlier attempt at the same compaction
          // (the backend hands the running one back on a repeat click).
          queryClient.setQueryData(
            getSessionCompactionQueryKey({ path: { id: sessionId, compactionId: data.id } }),
            data,
          )
          setAttempt({ sessionId, phase: 'polling', compactionId: data.id })
        },
        onError: (e) => {
          if (currentSessionId.current !== sessionId) return
          const message = apiErrorMessage(e, t('sessions.compact.failed'))
          setAttempt({ sessionId, phase: 'failed', message })
          toast.add({ type: 'error', title: message })
        },
      },
    )
  }

  return {
    start,
    /** A compaction of this session is being started, run, or opened — the one
     * flag both the header button and the cost banner read. */
    inFlight,
    /** Why the last attempt on this session ended without a new session, until
     * the next one starts. */
    error: mine?.phase === 'failed' ? mine.message : null,
  }
}
