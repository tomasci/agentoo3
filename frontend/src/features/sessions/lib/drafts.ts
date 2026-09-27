/**
 * One session's unsent composer state — its text, and the ids of any
 * attachments already sitting in the tray, done, the last time this reader
 * looked at it. An attachment belongs in here, not only in memory: the
 * backend announces every ready session file with no `announced_seq` to the
 * *next* prompt (`session-run.worker.ts`), so a file left in the tray after a
 * reload is still going out with the next message even though the tray that
 * used to show it is gone. `use-session-files.ts`'s tray is the in-memory
 * side of "survives navigating away and back"; this module is what survives
 * a reload.
 *
 * `text` (`hooks/use-session-draft.ts`) and `fileIds` (`hooks/
 * use-session-files.ts`'s tray, written back on every tray change) come from
 * two hooks that know nothing of each other, and can each write at any
 * moment — the tray's own writer, in particular, keeps writing from an
 * upload's `.then()`/`.catch()` whether or not any `SessionPage` is even
 * mounted to see it. `updateDraft` below is what keeps one write from
 * clobbering the other's field: it always reads the *current* stored value
 * first and merges only the field its own caller is changing over it, never
 * replaces the whole record from a snapshot that might already be stale by
 * the time it runs.
 */
export interface SessionDraft {
  text: string
  fileIds: string[]
}

/** A fresh object every call, never a shared singleton: `updateDraft` below
 *  only shallow-copies whatever `readDraft` hands it, so a caller anywhere
 *  that mutated a shared empty draft's `fileIds` array in place — a stray
 *  `.push`, say — would corrupt every future "no draft" read for every
 *  session, not just the one that mutated it. */
function emptyDraft(): SessionDraft {
  return { text: '', fileIds: [] }
}

function draftKey(sessionId: string): string {
  return `agentoo:draft:${sessionId}`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * localStorage outlives this build of the app and can be edited by hand, so a
 * read that throws — bad JSON, storage unavailable — or a value that isn't
 * this exact shape both come back as "no draft" rather than throwing out of a
 * render, the same defensive read `shared/store/tabs.ts` does for the tab row.
 */
export function readDraft(sessionId: string): SessionDraft {
  try {
    const raw = localStorage.getItem(draftKey(sessionId))
    if (raw === null) return emptyDraft()
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Partial<SessionDraft>).text !== 'string' ||
      !isStringArray((parsed as Partial<SessionDraft>).fileIds)
    ) {
      return emptyDraft()
    }
    const { text, fileIds } = parsed as SessionDraft
    return { text, fileIds }
  } catch {
    return emptyDraft()
  }
}

/** Removes the key entirely once there is nothing left worth restoring, so an
 *  installation that opens a great many sessions over its lifetime never
 *  accumulates empty entries for ones the reader has since cleared or sent. */
function writeDraft(sessionId: string, draft: SessionDraft): void {
  try {
    if (draft.text === '' && draft.fileIds.length === 0) {
      localStorage.removeItem(draftKey(sessionId))
      return
    }
    localStorage.setItem(draftKey(sessionId), JSON.stringify(draft))
  } catch {
    // Storage unavailable or full: the draft still works for this tab, it
    // just will not be there to read back after a reload.
  }
}

type Listener = () => void
const listeners = new Map<string, Set<Listener>>()

function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/**
 * Notified after every `updateDraft` for this session, whichever of the two
 * writers made it. `hooks/use-session-draft.ts`'s `useSessionDraft` is the
 * one subscriber today (through `useSyncExternalStore`), so a `fileIds`-only
 * write the tray makes reaches it too — without that, a page already
 * rendered would keep showing whatever `text` it read at mount and never
 * notice the tray had changed `fileIds` out from under it, even though nothing
 * here actually reads `fileIds` back through this path yet.
 */
export function subscribeDraft(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}

/**
 * The one place anything writes a session's draft: reads the current stored
 * value, merges `patch` over it, and writes the result — so a `fileIds`-only
 * patch (the tray) never clobbers a concurrent `text`-only patch (the
 * composer) or vice versa, no matter which one runs last.
 */
export function updateDraft(sessionId: string, patch: Partial<SessionDraft>): SessionDraft {
  const next = { ...readDraft(sessionId), ...patch }
  writeDraft(sessionId, next)
  notify(sessionId)
  return next
}
