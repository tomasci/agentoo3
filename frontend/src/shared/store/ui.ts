import { atomWithStorage } from 'jotai/utils'

// Persisted per browser, so a reload keeps the reader's choice.
export const themeAtom = atomWithStorage<'light' | 'dark'>('agentoo:theme', 'dark')

// Persisted per browser, same as the theme: a reader who tucks the sidebar
// away expects it to stay tucked away after a reload, not spring back open.
// Forced closed for the 'new' tab mode regardless of this value (root-layout.tsx)
// — that is a per-render decision, not a preference, so it is never written here.
export const sidebarOpenAtom = atomWithStorage('agentoo:sidebar-open', true)
