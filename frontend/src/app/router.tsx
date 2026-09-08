import { createRootRoute, createRoute, createRouter, Link, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AgentEditorPage, LibraryPage, SkillEditorPage } from '@/features/library'
import { SettingsPage } from '@/features/settings'
import { SshKeysPage } from '@/features/ssh-keys'
import { StoragePage } from '@/features/storage'
import { PromptEditorPage } from '@/features/system'
import { SYSTEM_HOME } from '@/shared/store/tabs'
import { Button, EmptyState } from '@/shared/ui'
import { ProjectLayout } from './project-layout'
import {
  IdeaDetailRoute,
  NewTabRoute,
  ProjectIdeasRoute,
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
  projectRoute.addChildren([
    projectOverviewRoute,
    projectSessionsRoute,
    sessionRoute,
    projectLibraryRoute,
    projectIdeasRoute,
    ideaDetailRoute,
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
  promptRoute,
])

/** An unknown URL should say so, not render an empty layout. */
function NotFound() {
  const { t } = useTranslation()
  return (
    <EmptyState
      title={t('notFound.message')}
      action={
        <Button asChild variant="secondary">
          <Link to={SYSTEM_HOME}>{t('notFound.back')}</Link>
        </Button>
      }
    />
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
