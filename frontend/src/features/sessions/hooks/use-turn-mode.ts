import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback } from 'react'
import type { TurnMode } from './use-sessions'

// In memory on purpose, unlike `composerModeAtom` and the draft text beside
// it, which both outlive a reload: this one decides whether the agent is
// allowed to touch anything, and nobody should come back to a composer that
// is silently still in a mode they forgot they had picked. Held for the life
// of the page, so it survives sending several messages and moving between
// sessions and tabs, but a reload starts every session over in Code.
//
// Keyed by session id rather than one global value, because a Q&A question
// asked in one session says nothing about what the next session's reader
// wants to do.
const turnModesAtom = atom<Record<string, TurnMode>>({})

/**
 * The Code / Q&A mode the next message in one session will be sent with.
 *
 * Derived from `sessionId` during render rather than synced into local state
 * by an effect, for the reason `useSessionDraft` documents: `SessionRoute`
 * renders `SessionPage` with no `key`, so a session switch reuses this hook
 * instance, and an effect would leave one render still showing the previous
 * session's mode — which `submit` could send.
 */
export function useTurnMode(sessionId: string): readonly [TurnMode, (mode: TurnMode) => void] {
  const modes = useAtomValue(turnModesAtom)
  const setModes = useSetAtom(turnModesAtom)
  const setMode = useCallback(
    (mode: TurnMode) =>
      setModes((current) =>
        current[sessionId] === mode ? current : { ...current, [sessionId]: mode },
      ),
    [sessionId, setModes],
  )
  return [modes[sessionId] ?? 'code', setMode]
}
