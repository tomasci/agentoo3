import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtomValue } from 'jotai'
import { useEffect } from 'react'
import {
  isBareShellPath,
  isFullBleedPath,
  projectIdForPath,
  shellModeForPath,
} from '@/shared/store/tabs'
import { themeAtom } from '@/shared/store/ui'
import styles from './layout.module.scss'
import { ProjectSidebar, SystemSidebar } from './sidebar'
import { StatusBar } from './status-bar'
import { TabBar } from './tab-bar'
import { useWorkspaceSync } from './use-tabs'
import { useVisualViewport } from './use-visual-viewport'

export function RootLayout() {
  const theme = useAtomValue(themeAtom)

  // The one thing both branches below need: applies regardless of whether
  // this render draws the app's own shell or hands the whole viewport to a
  // bare route.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const { pathname } = useLocation()

  // The standalone editor launcher (shared/store/tabs.ts's `isBareShellPath`)
  // opens in its own browser tab, target="_blank", with no app shell around
  // it at all — not the tab bar, not the sidebar, not the status bar. Split
  // into a sibling component rather than branching with an early return
  // here: `Shell`'s own hooks (`useWorkspaceSync`, `useVisualViewport`) must
  // still be called unconditionally on every one of *its* renders, and an
  // early return in this component would instead make calling them
  // conditional on `pathname` — a rules-of-hooks violation the moment a
  // reader navigates between a bare and a shelled route without `RootLayout`
  // itself unmounting (the "back to session" link on a launcher error state
  // does exactly that, in the same tab).
  if (isBareShellPath(pathname)) return <Outlet />

  return <Shell />
}

/**
 * The app's ordinary chrome — tab bar, sidebar, status bar — around whatever
 * page is showing. Its own component, not inlined into `RootLayout`, so the
 * bare launcher route above skips every one of these hooks rather than only
 * their rendered output; `useWorkspaceSync` in particular must never run for
 * that route; see shared/store/tabs.ts's `isBareShellPath`.
 */
function Shell() {
  // Publishes --shell-height from the visual viewport, so the iOS keyboard
  // shrinks the shell instead of the composer sitting under 100dvh, which
  // never sees the keyboard at all.
  useVisualViewport()

  // Mounted here, once: the workspace is kept in step with the URL on every
  // page, not only while the tab bar happens to be looking.
  useWorkspaceSync()

  const { pathname } = useLocation()
  const mode = shellModeForPath(pathname)
  const projectId = projectIdForPath(pathname)
  const bleed = isFullBleedPath(pathname)

  // An empty tab has nothing to navigate yet: until it is pointed at a project,
  // the picker gets the whole width rather than a sidebar of dead links.
  const withoutSidebar = mode === 'new'

  return (
    <div className={`${styles.shell} ${withoutSidebar ? styles.shellBare : ''}`}>
      <TabBar />

      {mode === 'project' && projectId && <ProjectSidebar projectId={projectId} />}
      {mode === 'system' && <SystemSidebar />}

      <main className={`${styles.body} ${bleed ? styles.bodyBleed : ''}`}>
        <Outlet />
      </main>

      <StatusBar />
    </div>
  )
}
