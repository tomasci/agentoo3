import { createRootRoute, createRoute, createRouter, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AgentEditorPage, LibraryPage, SkillEditorPage } from '@/features/library'
import { ProjectsPage } from '@/features/projects'
import { SshKeysPage } from '@/features/ssh-keys'
import { ProjectLayout } from './project-layout'
import { ProjectLibraryRoute, ProjectOverviewRoute, ProjectSessionsRoute } from './project-routes'
import { RootLayout } from './root-layout'

// Code-based routes rather than the file-based convention: file-based needs a
// Vite plugin and a generated routeTree, and this project already generates its
// API client at install time. One codegen step is enough.
const rootRoute = createRootRoute({ component: RootLayout })

// `/` is not a page of its own — projects is the home screen, and giving it a
// real URL means it can be linked and bookmarked like everything else.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/projects' })
  },
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  projectRoute.addChildren([projectOverviewRoute, projectSessionsRoute, projectLibraryRoute]),
  // `new` before `$name`, or "new" would be read as a name.
  newAgentRoute,
  agentRoute,
  newSkillRoute,
  skillRoute,
  libraryRoute,
  sshKeysRoute,
])

/** An unknown URL should say so, not render an empty layout. */
function NotFound() {
  const { t } = useTranslation()
  return (
    <div style={{ padding: '3rem 0', textAlign: 'center' }}>
      <p style={{ margin: '0 0 1rem', color: 'var(--muted-fg)' }}>{t('notFound.message')}</p>
      <Link to="/projects">{t('notFound.back')}</Link>
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
