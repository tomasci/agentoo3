import { atomWithStorage } from 'jotai/utils'

// Persisted per browser, so a reload keeps the reader's choice.
export const themeAtom = atomWithStorage<'light' | 'dark'>('agentoo:theme', 'dark')

export type Route =
  | { name: 'projects' }
  | { name: 'ssh-keys' }
  | { name: 'project'; projectId: string }

// A handful of views does not justify a router dependency. Persisted, so a
// reload keeps you on the project you were looking at.
export const routeAtom = atomWithStorage<Route>('agentoo:route', { name: 'projects' })
