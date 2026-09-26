import { atom } from 'jotai'

/**
 * Stream keys — one per open `EventSource`, session id for
 * `use-session-stream.ts` — whose stream is currently in the "erroring, retry
 * scheduled" state. Not persisted: it describes live connections in this
 * window, which no reload can be in the middle of.
 *
 * The *first* connection attempt never belongs here — it has not failed yet,
 * so it is merely connecting, not reconnecting (each writer's own effect is
 * what enforces that: the key is only ever added from an `error` handler,
 * never from mount — the same rule `use-container-logs.ts`'s own local
 * `reconnecting` state already follows). Read by the status bar
 * (app/status-bar.tsx) to fold every live stream into one "Reconnecting…"
 * line, so a dropped stream is visible without opening the tab it belongs to.
 */
export const reconnectingStreamsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Same "no-op stays identity-equal" rule `shared/store/tabs.ts`'s own
 *  writers follow, so a redundant add/remove triggers no re-render. */
function withKey(current: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return current.has(key) ? current : new Set<string>(current).add(key)
}

function withoutKey(current: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!current.has(key)) return current
  const next = new Set<string>(current)
  next.delete(key)
  return next
}

export const addReconnectingStreamAtom = atom(null, (get, set, key: string) => {
  set(reconnectingStreamsAtom, withKey(get(reconnectingStreamsAtom), key))
})

export const removeReconnectingStreamAtom = atom(null, (get, set, key: string) => {
  set(reconnectingStreamsAtom, withoutKey(get(reconnectingStreamsAtom), key))
})
