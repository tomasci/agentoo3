import { useCallback, useSyncExternalStore } from 'react'
import { readDraft, subscribeDraft, updateDraft } from '../lib/drafts'

/**
 * The composer's own text for one session — see lib/drafts.ts for the
 * persisted shape and why an attachment's ids are part of the same record
 * (owned by use-session-files.ts's tray, not by this hook).
 *
 * Read through `useSyncExternalStore`, not a `useState` a layout effect
 * corrects afterwards: `SessionRoute` renders `SessionPage` with no `key`
 * (see that component's own comment on the same hazard for its
 * scroll-tracking refs), so switching from one session to another reuses
 * this exact hook instance. `getSnapshot` below runs *during* render — on
 * the very first render with the new `sessionId`, synchronously, before
 * anything commits — so there is no post-commit window, not even one frame,
 * in which this could still be showing the previous session's text. A
 * layout effect correcting a plain `useState` after the fact would have
 * exactly that window, and — worse, on this page — a *second* hook
 * reconciling from a mixed snapshot could read the stale value out of it and
 * write it back somewhere durable before the correction ever lands.
 */
export function useSessionDraft(sessionId: string) {
  const text = useSyncExternalStore(
    useCallback((onStoreChange) => subscribeDraft(sessionId, onStoreChange), [sessionId]),
    () => readDraft(sessionId).text,
  )

  const setText = useCallback(
    (value: string | ((current: string) => string)) => {
      const current = readDraft(sessionId).text
      updateDraft(sessionId, { text: typeof value === 'function' ? value(current) : value })
    },
    [sessionId],
  )

  return { text, setText }
}
