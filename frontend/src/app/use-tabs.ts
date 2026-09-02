import { useLocation, useNavigate } from '@tanstack/react-router'
import { useAtom, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo } from 'react'
import { useProjects } from '@/features/projects'
import {
  activeTabIdForPath,
  adoptTab,
  closeTab as closeTabIn,
  dismissedTabIdsAtom,
  newTab,
  nextNewTabSeq,
  openProject as openProjectIn,
  pruneProjectTabs,
  rememberPath,
  SYSTEM_HOME,
  shellModeForPath,
  type Tab,
  tabsAtom,
} from '@/shared/store/tabs'

/** The ids in `before` that `after` no longer has. */
const removed = (before: Tab[], after: Tab[]) =>
  before.filter((tab) => !after.includes(tab)).map((tab) => tab.id)

/**
 * Reads the tab row and acts on it.
 *
 * Safe to call from anywhere: it holds no effects of its own, so the tab bar,
 * the shell and a page can all use it without three copies of the same
 * bookkeeping running against each other. Keeping the stored row in step with
 * the URL is `useWorkspaceSync`, mounted once.
 *
 * Actions navigate, because moving between tabs *is* navigation — the back
 * button then walks the workspace the way it walks any other page.
 */
export function useTabs() {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setDismissed = useSetAtom(dismissedTabIdsAtom)
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const activeId = activeTabIdForPath(pathname)
  const active = tabs.find((tab) => tab.id === activeId) ?? null

  // Tab paths are computed at runtime, so they arrive as strings rather than as
  // one of the router's literal route ids. `href` is the router's own escape
  // hatch for that, and still resolves to an in-app navigation.
  const go = useCallback((path: string) => void navigate({ href: path }), [navigate])

  const dismiss = useCallback(
    (ids: string[]) => {
      if (ids.length > 0) setDismissed((current) => [...current, ...ids])
    },
    [setDismissed],
  )

  /** Adds an empty tab and shows its picker. */
  const addTab = useCallback(() => {
    const created = newTab(nextNewTabSeq(tabs))
    setTabs([...tabs, created])
    go(created.path)
  }, [tabs, setTabs, go])

  /** Shows an existing tab, back at wherever it was. */
  const selectTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id)
      if (tab) go(tab.path)
    },
    [tabs, go],
  )

  const closeTab = useCallback(
    (id: string) => {
      const result = closeTabIn(tabs, id)
      if (result.tabs === tabs) return
      dismiss([id])
      setTabs(result.tabs)
      // Closing a tab you were not looking at should not move you.
      if (id !== activeId) return
      const heir = result.tabs.find((tab) => tab.id === result.activeId)
      go(heir?.path ?? SYSTEM_HOME)
    },
    [tabs, activeId, setTabs, go, dismiss],
  )

  /** Settles a project into the tab that asked for it, and opens it. */
  const openProject = useCallback(
    (projectId: string, fromTabId?: string) => {
      const result = openProjectIn(tabs, projectId, fromTabId ?? activeId)
      // The picker that asked for this project is retired by the move, and must
      // not be adopted back while the URL still names it.
      dismiss(removed(tabs, result.tabs))
      setTabs(result.tabs)
      const opened = result.tabs.find((tab) => tab.id === result.activeId)
      go(opened?.path ?? SYSTEM_HOME)
    },
    [tabs, activeId, setTabs, go, dismiss],
  )

  return {
    tabs,
    activeId,
    active,
    /** Which shell to draw: project nav, system nav, or the bare picker. */
    mode: shellModeForPath(pathname),
    addTab,
    selectTab,
    closeTab,
    openProject,
  }
}

/**
 * Keeps the stored tab row in step with the URL and with the server.
 *
 * Mounted once, in the shell: these are three rules about the workspace as a
 * whole, not about whoever happens to be rendering.
 */
export function useWorkspaceSync() {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [dismissed, setDismissed] = useAtom(dismissedTabIdsAtom)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { data: projects } = useProjects()

  const activeId = activeTabIdForPath(pathname)
  const active = tabs.find((tab) => tab.id === activeId) ?? null
  // Stable while the project list is unchanged, so the effects below settle
  // instead of re-running on every render.
  const projectIds = useMemo(() => projects?.map((project) => project.id), [projects])

  const go = useCallback((path: string) => void navigate({ href: path }), [navigate])

  // A URL naming a tab we do not have: a pasted link, a bookmark, or a project
  // opened in another window. Waits for the project list, so a slow request
  // cannot conjure a tab for a project that turns out to be gone.
  useEffect(() => {
    if (active) {
      // Landed on a real tab: whatever we retired is safely behind us.
      if (dismissed.length > 0) setDismissed([])
      return
    }
    if (!projectIds || dismissed.includes(activeId)) return
    const next = adoptTab(tabs, activeId, pathname, projectIds)
    if (next !== tabs) setTabs(next)
  }, [active, activeId, pathname, projectIds, tabs, setTabs, dismissed, setDismissed])

  // Where each tab was looking, so switching away and back returns to the same
  // page rather than to the tab's front page.
  useEffect(() => {
    if (!active) return
    const next = rememberPath(tabs, active.id, pathname)
    if (next !== tabs) setTabs(next)
  }, [active, pathname, tabs, setTabs])

  // Projects can disappear under us — deleted in another tab, or by someone
  // else on the same server. Their tabs go with them.
  useEffect(() => {
    if (!projectIds) return
    const next = pruneProjectTabs(tabs, projectIds)
    if (next === tabs) return
    setDismissed((current) => [...current, ...removed(tabs, next)])
    setTabs(next)
    // The tab that was showing is the one that just went: fall back, rather
    // than leaving a "project not found" page with no tab selected.
    if (!next.some((tab) => tab.id === activeId)) go(SYSTEM_HOME)
  }, [projectIds, tabs, activeId, setTabs, go, setDismissed])
}

export type { Tab }
