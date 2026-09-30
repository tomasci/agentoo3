import { createRootRoute, createRoute, createRouter, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { DockerSystemPage } from '@/features/docker'
import { AgentEditorPage, LibraryPage, SkillEditorPage } from '@/features/library'
import { SessionsDashboardPage } from '@/features/sessions'
import { SettingsPage } from '@/features/settings'
import { SshKeysPage } from '@/features/ssh-keys'
import { StoragePage } from '@/features/storage'
import { PortsPage, PromptEditorPage } from '@/features/system'
import { SYSTEM_HOME } from '@/shared/store/tabs'
import { buttonVariants } from '@/shared/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { ProjectLayout } from './project-layout'
import {
  IdeaDetailRoute,
  NewTabRoute,
  ProjectDockerRoute,
  ProjectIdeasRoute,
  ProjectLibraryRoute,
  ProjectSessionsRoute,
  ProjectSettingsRoute,
  SessionDockerRoute,
  SessionEditorRoute,
  SessionRoute,
} from './project-routes'
import { RootLayout } from './root-layout'

// Code-based routes rather than the file-based convention: file-based needs a
// Vite plugin and a generated routeTree, and this project already generates its
// API client at install time. One codegen step is enough.
const rootRoute = createRootRoute({ component: RootLayout })

// `/` is not a page of its own. Every page belongs to a tab, and the one tab
// that is always open is the system tab, so that is where a bare visit lands.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: SYSTEM_HOME })
  },
})

// An empty tab, showing the picker. The tab id is in the URL so a reload — or a
// second window — restores the same empty tab rather than inventing another.
const newTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tab/$tabId',
  component: NewTabRoute,
})

// The System tab's default page (`SYSTEM_HOME`, shared/store/tabs.ts):
// everything running or waiting on the operator right now, across every
// project — not scoped under `projectRoute` below, since it is precisely the
// page for not having to already know which project to look in.
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsDashboardPage,
})

// The System tab's Docker page: every container on the host, across every
// project — the host-wide counterpart to `projectDockerRoute` below, which
// only ever shows one project's own containers. Not nested under
// `projectRoute`: it takes no `$projectId` of its own, and
// `activeTabIdForPath` (shared/store/tabs.ts) already resolves any path
// outside `/projects/...` to the system tab.
const dockerSystemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docker',
  component: DockerSystemPage,
})

// A layout route, so /projects/$projectId/* shares the project lookup and the
// current-project selection instead of repeating them per page.
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectLayout,
})

// `/projects/$projectId` is not a page of its own any more — Settings moved
// to its own path below, so an old link or a tab path saved before that move
// (localStorage's `agentoo:tabs`) has to land somewhere, and Sessions is that
// project's default page (`projectHome`, shared/store/tabs.ts).
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/projects/$projectId/sessions', params })
  },
})

// The project's own page: details, SSH key, retry, delete. `ProjectOverview`
// (features/projects) keeps its name — the page still shows an overview of
// the project — but the route lives at /settings and the sidebar calls it
// Settings, pinned to the bottom of the nav (sidebar.tsx).
const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings',
  component: ProjectSettingsRoute,
})

const projectSessionsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions',
  component: ProjectSessionsRoute,
})

// One session, with its transcript. A child of the project layout, so the
// sidebar keeps showing which project you are in.
const sessionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId',
  component: SessionRoute,
})

// A session's own Docker dashboard: the same page as `projectDockerRoute`
// below, scoped to this session's own git worktree instead of the project's
// repo/ checkout (DockerPage's `sessionId` prop — see docker-page.tsx and
// backend/src/features/docker/scope.ts). A path segment, not a `?sessionId=`
// search param: this app has no `validateSearch` anywhere, and a tab
// remembers its own `path` (shared/store/tabs.ts) — a search param would be
// the one piece of state that path forgot. `activeTabIdForPath`'s
// `^/projects/([^/]+)` match still resolves this to the same project tab as
// every other route below.
const sessionDockerRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId/docker',
  component: SessionDockerRoute,
})

// A session's own code-server (VS Code in the browser), scoped to this
// session's own git worktree — see features/editor/components/editor-launcher.tsx
// and the design doc it was built from. Opened only as its own browser tab
// (the session header's Editor link sets target="_blank"), and rendered with
// no app shell at all — not merely full-bleed inside one, as it used to be:
// `RootLayout` matches this exact path (`isBareShellPath`,
// shared/store/tabs.ts) and renders a bare `<Outlet />` instead of its usual
// tab bar/sidebar/status bar. This route still nests under `projectRoute`
// for the same lookup every other project route gets — `ProjectLayout` is
// not part of that shell, only `RootLayout`'s own chrome is.
const sessionEditorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sessions/$sessionId/editor',
  component: SessionEditorRoute,
})

const projectLibraryRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/library',
  component: ProjectLibraryRoute,
})

// The project's Docker / Docker Compose dashboard — always a child of the
// project layout, and always in the sidebar (sidebar.tsx's `nav.docker`),
// regardless of whether anything was actually detected: the page is what
// explains that, not the nav.
const projectDockerRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/docker',
  component: ProjectDockerRoute,
})

// The Idea Manager's board: six fixed columns, one project's worth of ideas.
const projectIdeasRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/ideas',
  component: ProjectIdeasRoute,
})

// One idea's canvas, comments, generated prompt and run history. A child of
// the project layout for the same reason `sessionRoute` is — the sidebar
// keeps showing which project this idea belongs to.
const ideaDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/ideas/$ideaId',
  component: IdeaDetailRoute,
})

// The global library. Editors are their own pages rather than dialogs: a prompt
// is the length of a document, and a document deserves an address.
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: LibraryPage,
})

const newAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/agents/new',
  component: () => <AgentEditorPage />,
})

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/agents/$name',
  component: function AgentRoute() {
    const { name } = agentRoute.useParams()
    return <AgentEditorPage name={name} />
  },
})

const newSkillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/skills/new',
  component: () => <SkillEditorPage />,
})

const skillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/skills/$name',
  component: function SkillRoute() {
    const { name } = skillRoute.useParams()
    return <SkillEditorPage name={name} />
  },
})

const sshKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ssh-keys',
  component: SshKeysPage,
})

// Preferences for the whole installation, and so a system-tab page: a project
// tab has no business changing the language of the app around it.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

// The System tab's storage dashboard: attachment usage and the
// reconciliation job's open anomalies, across every session.
const storageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/storage',
  component: StoragePage,
})

// The System tab's live port table (a structured `ss -tulpn`): which
// process, if any, owns each socket on the host.
const portsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ports',
  component: PortsPage,
})

// An operator-editable instruction, addressed by the backend's own fixed name
// for it (KNOWN_PROMPTS in features/system/prompts.ts) rather than by
// anything a user picks — there is no "new prompt" route, unlike the library's
// agents and skills, because this is not a collection. System-tab, not
// project-tab: the instruction is installation-wide.
const promptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/prompts/$name',
  component: function PromptRoute() {
    const { name } = promptRoute.useParams()
    return <PromptEditorPage name={name} />
  },
})

// Exported so a test can build its own router over the same tree, with a
// history it controls, rather than the browser one this module's router uses.
export const routeTree = rootRoute.addChildren([
  indexRoute,
  newTabRoute,
  sessionsRoute,
  dockerSystemRoute,
  projectRoute.addChildren([
    projectIndexRoute,
    projectSessionsRoute,
    sessionRoute,
    sessionDockerRoute,
    sessionEditorRoute,
    projectDockerRoute,
    projectLibraryRoute,
    projectIdeasRoute,
    ideaDetailRoute,
    projectSettingsRoute,
  ]),
  // `new` before `$name`, or "new" would be read as a name.
  newAgentRoute,
  agentRoute,
  newSkillRoute,
  skillRoute,
  libraryRoute,
  sshKeysRoute,
  settingsRoute,
  storageRoute,
  portsRoute,
  promptRoute,
])

/** An unknown URL should say so, not render an empty layout. */
function NotFound() {
  const { t } = useTranslation()
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{t('notFound.message')}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Link to={SYSTEM_HOME} className={buttonVariants({ variant: 'secondary' })}>
          {t('notFound.back')}
        </Link>
      </EmptyContent>
    </Empty>
  )
}

export const router = createRouter({
  routeTree,
  // React Query owns data freshness; the router only needs to render.
  defaultPreload: 'intent',
  defaultNotFoundComponent: NotFound,
})

// Makes `to`, `params` and `search` type-checked across the app.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
