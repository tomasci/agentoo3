import { createRootRoute, createRoute, createRouter, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AgentEditorPage, LibraryPage, SkillEditorPage } from '@/features/library'
import { SettingsPage } from '@/features/settings'
import { SshKeysPage } from '@/features/ssh-keys'
import { SYSTEM_HOME } from '@/shared/store/tabs'
import { ProjectLayout } from './project-layout'
import {
  NewTabRoute,
  ProjectLibraryRoute,
  ProjectOverviewRoute,
  ProjectSessionsRoute,
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

// A layout route, so /projects/$projectId/* shares the project lookup and the
// current-project selection instead of repeating them per page.
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectLayout,
})

const projectOverviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: ProjectOverviewRoute,
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

const projectLibraryRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/library',
  component: ProjectLibraryRoute,
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

// Exported so a test can build its own router over the same tree, with a
// history it controls, rather than the browser one this module's router uses.
export const routeTree = rootRoute.addChildren([
  indexRoute,
  newTabRoute,
  projectRoute.addChildren([
    projectOverviewRoute,
    projectSessionsRoute,
    sessionRoute,
    projectLibraryRoute,
  ]),
  // `new` before `$name`, or "new" would be read as a name.
  newAgentRoute,
  agentRoute,
  newSkillRoute,
  skillRoute,
  libraryRoute,
  sshKeysRoute,
  settingsRoute,
])

/** An unknown URL should say so, not render an empty layout. */
function NotFound() {
  const { t } = useTranslation()
  return (
    <div style={{ padding: '3rem 0', textAlign: 'center' }}>
      <p style={{ margin: '0 0 1rem', color: 'var(--muted-fg)' }}>{t('notFound.message')}</p>
      <Link to={SYSTEM_HOME}>{t('notFound.back')}</Link>
    </div>
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
