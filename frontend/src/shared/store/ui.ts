import { atomWithStorage } from 'jotai/utils'

// Persisted per browser, so a reload keeps the reader's choice.
export const themeAtom = atomWithStorage<'light' | 'dark'>('agentoo:theme', 'dark')

export type Page = 'projects' | 'ssh-keys'

// Two pages do not justify a router dependency. Persisted so a reload keeps you
// where you were.
export const pageAtom = atomWithStorage<Page>('agentoo:page', 'projects')
