import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtom, useAtomValue } from 'jotai'
import type { CSSProperties } from 'react'
import { useEffect } from 'react'
import {
  isBareShellPath,
  isFullBleedPath,
  projectIdForPath,
  shellModeForPath,
} from '@/shared/store/tabs'
import { sidebarOpenAtom, themeAtom } from '@/shared/store/ui'
import { SidebarInset, SidebarProvider, useSidebar } from '@/shared/ui/sidebar'
import { ShellSidebar } from './sidebar'
import { StatusBar } from './status-bar'
import { TabBar } from './tab-bar'
import { useWorkspaceSync } from './use-tabs'
import { useVisualViewport } from './use-visual-viewport'

export function RootLayout() {
  const theme = useAtomValue(themeAtom)

  // The one thing both branches below need: applies regardless of whether
  // this render draws the app's own shell or hands the whole viewport to a
  // bare route. `classList`/`colorScheme` are what shadcn's own tokens (and
  // every native form control) key off.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.style.colorScheme = theme
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
 * Base UI's Sheet (the sidebar's phone form) does not close itself on
 * navigation the way a browser tab does — a tap on a nav link would otherwise
 * leave the drawer sitting open over the very page it just opened. Renders
 * nothing: it exists only for the effect, and only needs to live inside
 * `SidebarProvider` to reach `useSidebar()`.
 */
function CloseSidebarOnNavigate() {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the navigation trigger, not a value read inside this effect
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  return null
}

/**
 * The app's ordinary chrome — tab bar, sidebar, status bar — around whatever
 * page is showing. Its own component, not inlined into `RootLayout`, so the
 * bare launcher route above skips every one of these hooks rather than only
 * their rendered output; `useWorkspaceSync` in particular must never run for
 * that route; see shared/store/tabs.ts's `isBareShellPath`.
 *
 * Built on shadcn's `Sidebar variant="inset"` + `SidebarInset` (dashboard-01):
 * the `SidebarProvider` wrapper and the inset sidebar share one `bg-sidebar`
 * surface, and `SidebarInset` is the only elevated thing on it — its own
 * `bg-background`, rounded, with a gap on every side. The tab bar and the
 * status bar are plain siblings of that row with no background of their own,
 * so they read as part of the same surface as the sidebar rather than as
 * separate chrome. See sidebar.tsx's `ShellSidebar` for how the sidebar itself
 * ends up positioned in the row between the two bars rather than pinned to
 * the whole viewport.
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

  // Persisted like the theme — but forced closed for an empty tab, which has
  // nothing to navigate yet (see `ShellSidebar`): that is a per-render fact
  // about this mode, not a preference, so it is read past rather than written
  // back when the provider reports it changed.
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)

  return (
    <SidebarProvider
      open={mode !== 'new' && sidebarOpen}
      onOpenChange={(open) => {
        if (mode !== 'new') setSidebarOpen(open)
      }}
      style={{ '--sidebar-width': 'calc(var(--spacing) * 72)' } as CSSProperties}
      className="h-[var(--shell-height,100dvh)] min-h-0 flex-col overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
    >
      <CloseSidebarOnNavigate />
      <TabBar mode={mode} />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ShellSidebar mode={mode} projectId={projectId} />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <div
            className={
              bleed
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'min-h-0 flex-1 overflow-y-auto p-4 lg:p-6'
            }
          >
            <Outlet />
          </div>
        </SidebarInset>
      </div>

      <StatusBar />
    </SidebarProvider>
  )
}
