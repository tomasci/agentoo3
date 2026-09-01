import { createRootRoute, createRoute, createRouter, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ProjectsPage } from '@/features/projects'
import { ProjectPage } from '@/features/sessions'
import { SshKeysPage } from '@/features/ssh-keys'
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

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams()
    return <ProjectPage projectId={projectId} />
  },
})

const sshKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ssh-keys',
  component: SshKeysPage,
})

const routeTree = rootRoute.addChildren([indexRoute, projectsRoute, projectRoute, sshKeysRoute])

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
