import { Link } from '@tanstack/react-router'
import {
  BookOpen,
  Container,
  FileKey,
  Gauge,
  HardDrive,
  KeyRound,
  Library,
  Lightbulb,
  MessagesSquare,
  Network,
  Settings,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { GLASS_CLASS_NAME, useBackdropActive } from '@/features/appearance'
import { useProjects } from '@/features/projects'
import { cn } from '@/shared/lib/utils'
import { SYSTEM_HOME, type TabKind } from '@/shared/store/tabs'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/shared/ui/sidebar'

interface SidebarBrandProps {
  /** The small caption above the heading — "System" or "Project". */
  eyebrow: ReactNode
  heading: ReactNode
  tagline?: ReactNode
  /**
   * Wraps the assembled eyebrow/heading/tagline block. The system sidebar's
   * heading is a link home; the project sidebar's is not — that's the one
   * real difference between the two, so it's the one thing left to the
   * caller rather than folded into a boolean.
   */
  render: (content: ReactNode) => ReactNode
}

/** The brand block both nav lists share, inside `SidebarHeader`. */
function SidebarBrand({ eyebrow, heading, tagline, render }: SidebarBrandProps) {
  return (
    <SidebarHeader>
      {render(
        <div className="flex flex-col gap-0.5 overflow-hidden p-2">
          <span className="text-xs font-semibold tracking-wide text-sidebar-foreground/70 uppercase">
            {eyebrow}
          </span>
          <h1 className="truncate text-lg leading-tight font-semibold text-sidebar-foreground">
            {heading}
          </h1>
          {tagline && <p className="truncate text-xs text-sidebar-foreground/70">{tagline}</p>}
        </div>,
      )}
    </SidebarHeader>
  )
}

/**
 * The system tab's nav: everything that belongs to the installation rather
 * than to any one project. No project navigation appears here — a project lives
 * in its own tab, and mixing the two is what made the old single-window shell
 * ambiguous about what "here" meant.
 */
function SystemNav({ glass }: { glass: boolean }) {
  const { t } = useTranslation()

  return (
    <>
      <SidebarBrand
        eyebrow={t('nav.system')}
        heading={t('app.title')}
        tagline={t('app.subtitle')}
        render={(content) => (
          <Link
            to={SYSTEM_HOME}
            className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            {content}
          </Link>
        )}
      />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className={cn('gap-1', glass && cn('rounded-xl p-1', GLASS_CLASS_NAME))}>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/sessions"
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <MessagesSquare />
                <span>{t('nav.systemSessions')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to="/docker" activeProps={{ 'aria-current': 'page', 'data-active': '' }} />
                }
              >
                <Container />
                <span>{t('nav.dockerSystem')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/library"
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                    activeOptions={{ exact: false }}
                  />
                }
              >
                <Library />
                <span>{t('nav.library')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/ssh-keys"
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <KeyRound />
                <span>{t('nav.sshKeys')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to="/storage" activeProps={{ 'aria-current': 'page', 'data-active': '' }} />
                }
              >
                <HardDrive />
                <span>{t('nav.storage')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to="/ports" activeProps={{ 'aria-current': 'page', 'data-active': '' }} />
                }
              >
                <Network />
                <span>{t('nav.ports')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to="/usage" activeProps={{ 'aria-current': 'page', 'data-active': '' }} />
                }
              >
                <Gauge />
                <span>{t('nav.usage')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/settings"
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <Settings />
                <span>{t('nav.configuration')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </>
  )
}

/**
 * A project tab's nav: that project, and nothing else.
 *
 * The heading is the project's name because the tab label is small and a tab
 * row full of similar names is easy to misread — the sidebar is where you
 * confirm which checkout you are about to run an agent against.
 */
function ProjectNav({ projectId, glass }: { projectId: string; glass: boolean }) {
  const { t } = useTranslation()
  const { data: projects } = useProjects()
  const project = projects?.find((candidate) => candidate.id === projectId)

  return (
    <>
      <SidebarBrand
        eyebrow={t('nav.project')}
        // Loading and gone are different things to say: a tab restored from a
        // deep link to a deleted project should not sit there saying it is
        // still fetching something.
        heading={project?.name ?? (projects ? t('tabs.unknown') : t('tabs.loading'))}
        tagline={project?.path}
        render={(content) => content}
      />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className={cn('gap-1', glass && cn('rounded-xl p-1', GLASS_CLASS_NAME))}>
            {/* Not exact: the session detail route (`/sessions/$sessionId`) is a
                child page of the same section, and should keep this item
                current rather than going dark once a session is opened. */}
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/projects/$projectId/sessions"
                    params={{ projectId }}
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <MessagesSquare />
                <span>{t('nav.sessions')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/projects/$projectId/docker"
                    params={{ projectId }}
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <Container />
                <span>{t('nav.docker')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* Right after Docker: the files this page manages exist to make
                that dashboard's `docker compose` actually find its `.env`
                files — `env-files/index.ts`'s `EnvFilesPage`. */}
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/projects/$projectId/env"
                    params={{ projectId }}
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <FileKey />
                <span>{t('nav.env')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* Non-exact: the detail route (`/ideas/$ideaId`) is a child page of
                the same section, and should keep this item current rather than
                going dark the moment a card is opened. */}
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/projects/$projectId/ideas"
                    params={{ projectId }}
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                    activeOptions={{ exact: false }}
                  />
                }
              >
                <Lightbulb />
                <span>{t('nav.ideas')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link
                    to="/projects/$projectId/library"
                    params={{ projectId }}
                    activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                  />
                }
              >
                <BookOpen />
                <span>{t('nav.projectLibrary')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      {/* Pinned to the bottom edge: `SidebarContent` above takes `flex-1` of the
          column, so this footer sits below whatever content there is rather
          than trailing directly after it. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  to="/projects/$projectId/settings"
                  params={{ projectId }}
                  activeProps={{ 'aria-current': 'page', 'data-active': '' }}
                />
              }
            >
              <Settings />
              <span>{t('nav.projectSettings')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}

interface ShellSidebarProps {
  mode: TabKind
  projectId: string | null
}

/**
 * The one `Sidebar` the shell ever mounts, in every mode on desktop — see
 * root-layout.tsx. `variant="inset"` is what turns the whole `SidebarProvider`
 * wrapper the same `bg-sidebar` colour as this sidebar (dashboard-01's trick:
 * the wrapper has `has-data-[variant=inset]:bg-sidebar`), so the tab bar and
 * status bar read as part of that same surface rather than floating chrome of
 * their own.
 *
 * `className="absolute h-auto"` overrides the generated component's own
 * `fixed … h-svh` on the same element (tailwind-merge dedupes the conflicting
 * utilities, last one wins): without it the sidebar pins itself to the whole
 * browser viewport, on top of the tab bar and the status bar. `absolute`
 * instead resolves against the nearest positioned ancestor — the `relative`
 * wrapper in root-layout.tsx that also holds `SidebarInset` — and `h-auto`
 * lets `inset-y-0` (kept from the original classes) stretch it to fill that
 * wrapper's height instead of forcing `100svh`. The result sits exactly in the
 * row between the two bars, with no height arithmetic of our own.
 */
export function ShellSidebar({ mode, projectId }: ShellSidebarProps) {
  const { isMobile, state } = useSidebar()

  // The desktop `sidebar-inner` div (shared/ui/sidebar.tsx) is an opaque
  // `bg-sidebar` — fine normally, since it *is* the wrapper's own surface, but
  // it would otherwise sit as an opaque block over root-layout.tsx's chosen
  // backdrop. `*:data-[slot=sidebar-inner]:bg-transparent` reaches through to
  // it the same way `app/status-bar.tsx`'s `HostMetric` reaches the generated
  // `Progress` indicator — applied conditionally, so the default look (no
  // background chosen) stays byte-for-byte what it was. The phone `Sheet`
  // form below never receives this `className` at all (shared/ui/sidebar.tsx
  // only spreads it onto the desktop branch), so the drawer stays the opaque
  // overlay it always was.
  const backdropActive = useBackdropActive()

  // `SystemNav`/`ProjectNav`'s own nav list goes glassy on the same condition
  // plus one more: the phone `Sheet` below is an opaque overlay drawer with no
  // backdrop behind it at all (see the comment above), so glass there would
  // just be a translucent panel over a plain colour — `!isMobile` keeps that
  // nav list opaque in the drawer regardless of `backdropActive`.
  const glassNav = backdropActive && !isMobile

  // An empty tab has nothing to navigate (see the comment below), and
  // root-layout.tsx forces the provider's desktop `open` closed for it — but
  // that prop doesn't reach the phone form: below 768px the sidebar is a
  // Sheet driven by the provider's own `openMobile` state instead, which
  // Ctrl/Cmd+B still toggles regardless of mode. Not mounting `Sidebar` here
  // at all is what keeps that shortcut from ever popping an empty drawer —
  // there is no Sheet listening to `openMobile` for it to open. Desktop keeps
  // the empty inset `Sidebar` below so the wrapper keeps its `bg-sidebar`
  // surface (see the doc comment above); mobile has no such wrapper to keep.
  if (mode === 'new' && isMobile) return null

  return (
    <Sidebar
      variant="inset"
      collapsible="offcanvas"
      className={cn(
        'absolute h-auto',
        backdropActive && '*:data-[slot=sidebar-inner]:bg-transparent',
      )}
      // Offcanvas moves the collapsed sidebar off-screen with a transform, not
      // `display: none` — its links would otherwise stay in the tab order and
      // reachable by a screen reader while invisible.
      inert={!isMobile && state === 'collapsed'}
    >
      {mode === 'project' && projectId && <ProjectNav projectId={projectId} glass={glassNav} />}
      {mode === 'system' && <SystemNav glass={glassNav} />}
      {/* 'new': an empty tab has nothing to navigate yet — the sidebar renders
          with nothing in it rather than a column of dead links (see
          root-layout.tsx, which also forces the provider closed in this mode). */}
    </Sidebar>
  )
}
