import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/**
 * The workspace is a row of tabs, the way a file manager is.
 *
 * One system tab holds everything that is not a project — the library, ssh keys,
 * configuration — and every other tab holds one project, or the picker offering
 * to choose one. A tab remembers where it was looking, so coming back to it
 * lands where you left rather than at its front page.
 *
 * The URL stays the single source of truth for *which* tab is showing: a tab is
 * identified by its content, so `/projects/<id>` can only be that project's tab
 * and a shared link opens the same thing it did for the sender. This module is
 * deliberately free of React and the router so the rules below can be tested as
 * plain functions.
 */

export type TabKind = 'system' | 'project' | 'new'

export type Tab = {
  id: string
  kind: TabKind
  /** Only on project tabs. */
  projectId?: string
  /** The tab's last location, so switching back restores it. */
  path: string
}

export const SYSTEM_TAB_ID = 'system'

/** Opening the system tab with nothing remembered lands on the library. */
export const SYSTEM_HOME = '/library'

export const systemTab = (): Tab => ({ id: SYSTEM_TAB_ID, kind: 'system', path: SYSTEM_HOME })

export const projectTabId = (projectId: string) => `project-${projectId}`
export const projectHome = (projectId: string) => `/projects/${projectId}`

export const projectTab = (projectId: string): Tab => ({
  id: projectTabId(projectId),
  kind: 'project',
  projectId,
  path: projectHome(projectId),
})

export const newTabPath = (tabId: string) => `/tab/${tabId}`
export const newTabId = (seq: number) => `new-${seq}`

export const newTab = (seq: number): Tab => {
  const id = newTabId(seq)
  return { id, kind: 'new', path: newTabPath(id) }
}

/**
 * The lowest unused sequence number, so ids stay short and predictable and a
 * closed tab's number can be reused rather than climbing forever.
 */
export function nextNewTabSeq(tabs: Tab[]): number {
  const taken = new Set(
    tabs
      .filter((tab) => tab.kind === 'new')
      .map((tab) => Number(tab.id.slice('new-'.length)))
      .filter((seq) => Number.isInteger(seq)),
  )
  let seq = 1
  while (taken.has(seq)) seq += 1
  return seq
}

/** Which tab a URL belongs to. Anything unrecognised is system business. */
export function activeTabIdForPath(pathname: string): string {
  const project = /^\/projects\/([^/]+)/.exec(pathname)
  if (project?.[1]) return projectTabId(decodeURIComponent(project[1]))

  const picker = /^\/tab\/([^/]+)/.exec(pathname)
  if (picker?.[1]) return decodeURIComponent(picker[1])

  return SYSTEM_TAB_ID
}

/**
 * Which shell a URL wants: project navigation, system navigation, or the bare
 * picker with no sidebar at all. Read from the path rather than from the tab
 * list so the layout is right on the first render, before any tab is adopted.
 */
export function shellModeForPath(pathname: string): TabKind {
  if (/^\/tab\//.test(pathname)) return 'new'
  if (/^\/projects\/[^/]+/.test(pathname)) return 'project'
  return 'system'
}

/** The project a URL is about, if any. */
export function projectIdForPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Routes that own their whole region: no body padding, no body scroll.
 *
 * A session's own live page draws its own scrolling transcript and composer
 * edge to edge; the shell's usual page padding would just be a second frame
 * around a page that already has one. Matches the session *detail* route only
 * — `/projects/:id/sessions` (the list) still wants the ordinary page body.
 */
export function isFullBleedPath(pathname: string): boolean {
  return /^\/projects\/[^/]+\/sessions\/[^/]+$/.test(pathname)
}

/**
 * Repairs whatever came out of storage.
 *
 * localStorage outlives any one build of the app, so the list has to be treated
 * as untrusted input: an older shape, a hand-edited value or a half-written
 * array must not be able to leave the workspace with no tabs to show.
 */
export function normalizeTabs(value: unknown): Tab[] {
  const raw = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const tabs: Tab[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { id, kind, projectId, path } = entry as Partial<Tab>
    if (typeof id !== 'string' || typeof path !== 'string') continue
    if (kind !== 'system' && kind !== 'project' && kind !== 'new') continue
    // A project tab without its project is not a tab, it is a dangling label.
    if (kind === 'project' && typeof projectId !== 'string') continue
    if (seen.has(id)) continue
    seen.add(id)
    tabs.push(kind === 'project' ? { id, kind, projectId, path } : { id, kind, path })
  }

  // The system tab is permanent and always leftmost — it is the one tab that
  // cannot be closed, so it is also the fallback when everything else goes.
  const system = tabs.find((tab) => tab.kind === 'system') ?? systemTab()
  return [system, ...tabs.filter((tab) => tab.kind !== 'system')]
}

/**
 * Opens a project in the workspace.
 *
 * A project is never open twice: asking for one already open focuses that tab
 * instead of making a second view of the same checkout, and the picker that
 * asked is retired since it has served its purpose.
 */
export function openProject(
  tabs: Tab[],
  projectId: string,
  fromTabId?: string,
): { tabs: Tab[]; activeId: string } {
  const id = projectTabId(projectId)
  const existing = tabs.find((tab) => tab.id === id)
  const from = fromTabId ? tabs.find((tab) => tab.id === fromTabId) : undefined
  const retiring = from?.kind === 'new' ? from.id : null

  if (existing) {
    return { tabs: tabs.filter((tab) => tab.id !== retiring), activeId: existing.id }
  }

  const opened = projectTab(projectId)
  // The picker becomes the project, keeping its place in the row: the tab you
  // were filling in is the tab you end up in.
  const next = retiring
    ? tabs.map((tab) => (tab.id === retiring ? opened : tab))
    : [...tabs, opened]

  return { tabs: next, activeId: opened.id }
}

/** Closes a tab and says which one should take over. The system tab stays. */
export function closeTab(tabs: Tab[], id: string): { tabs: Tab[]; activeId: string } {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 1) return { tabs, activeId: id }

  // Prefer the tab to the right, as browsers do; index 0 is the system tab, so
  // there is always something to fall back to on the left.
  const heir = tabs[index + 1] ?? tabs[index - 1] ?? tabs[0]
  return {
    tabs: tabs.filter((tab) => tab.id !== id),
    activeId: heir?.id ?? SYSTEM_TAB_ID,
  }
}

/**
 * Takes in a tab named by the URL but missing from the list, so a pasted link
 * or a restored session opens a real tab rather than an unselected shell.
 *
 * The URL has to vouch for the tab and the server has to vouch for the project:
 * adopting a project that is not in `projectIds` would fight with the pruning
 * that removed it, each undoing the other on every render.
 */
export function adoptTab(tabs: Tab[], id: string, pathname: string, projectIds: string[]): Tab[] {
  if (tabs.some((tab) => tab.id === id)) return tabs

  const projectId = projectIdForPath(pathname)
  if (projectId && id === projectTabId(projectId)) {
    if (!projectIds.includes(projectId)) return tabs
    return [...tabs, { ...projectTab(projectId), path: pathname }]
  }
  if (/^new-\d+$/.test(id)) return [...tabs, { id, kind: 'new', path: newTabPath(id) }]

  return tabs
}

/**
 * Drops tabs for projects that no longer exist — deleted here or elsewhere.
 *
 * Returns the *same array* when every project is still there. This is load
 * bearing: the effect that calls this compares by identity to decide whether to
 * write, and `filter` alone always returns a new array — which read as a change
 * on every render and looped until the tab died.
 */
export function pruneProjectTabs(tabs: Tab[], projectIds: string[]): Tab[] {
  const live = new Set(projectIds)
  const keep = (tab: Tab) => tab.kind !== 'project' || live.has(tab.projectId ?? '')
  return tabs.every(keep) ? tabs : tabs.filter(keep)
}

/** Records where a tab is looking. Returns the same array when nothing moved. */
export function rememberPath(tabs: Tab[], id: string, path: string): Tab[] {
  const tab = tabs.find((candidate) => candidate.id === id)
  if (!tab || tab.path === path) return tabs
  return tabs.map((candidate) => (candidate.id === id ? { ...candidate, path } : candidate))
}

// Persisted, so the workspace is still open the way you left it after a reload.
const storedTabsAtom = atomWithStorage<Tab[]>('agentoo:tabs', [systemTab()])

export const tabsAtom = atom(
  (get) => normalizeTabs(get(storedTabsAtom)),
  (_get, set, next: Tab[]) => set(storedTabsAtom, normalizeTabs(next)),
)

/**
 * Tabs closed on purpose, until the URL catches up.
 *
 * Removing a tab leaves the address bar pointing at it for the moment it takes
 * the navigation away to land, and a URL is otherwise taken as reason enough to
 * open a tab. Held in the store rather than in a component, because the closing
 * happens in the tab bar while the adopting happens in the shell: a ref in
 * either one would be invisible to the other. Not persisted — it describes a
 * navigation in flight, which no reload can be in the middle of.
 */
export const dismissedTabIdsAtom = atom<string[]>([])
