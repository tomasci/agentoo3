import { atomWithStorage } from 'jotai/utils'

// Persisted per browser, so a reload keeps the reader's choice.
export const themeAtom = atomWithStorage<'light' | 'dark'>('agentoo:theme', 'dark')

// The project you are working in, the way an IDE holds one open. Opening a
// project selects it, and it stays selected as you move around the app until
// you pick another. Stored as an id rather than the project itself so it cannot
// go stale against the server.
export const currentProjectIdAtom = atomWithStorage<string | null>('agentoo:currentProject', null)
