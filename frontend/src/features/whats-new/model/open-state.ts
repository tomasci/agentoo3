import { atom } from 'jotai'

/**
 * Null when the screen is closed. `'installed'` when it auto-opened itself
 * for a pending install (see components/whats-new-screen.tsx's own effect) —
 * closing it in that mode fires POST /whats-new/dismiss for the install that
 * was shown. `'manual'` when the status bar's version button reopened it
 * (use-open-whats-new.ts) — closing it there is just local state, nothing to
 * dismiss, since the install it would dismiss may already have been.
 *
 * Not persisted: there is nothing here worth surviving a reload on its own —
 * the server-held `pending` flag (use-whats-new.ts) is what decides whether
 * the screen opens again, not this atom's own last value.
 */
export type WhatsNewMode = 'installed' | 'manual' | null

export const whatsNewOpenAtom = atom<WhatsNewMode>(null)
