import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import styles from './layout.module.scss'

interface SidebarShellProps {
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
  renderBrand: (content: ReactNode) => ReactNode
  /** The nav links — the other real difference, since each tab's route params differ. */
  children: ReactNode
}

/**
 * The shell both sidebars share: identical brand/logo/tagline/nav markup over
 * the same classes. What used to be two copies of this now differs only in
 * the brand wrapper, the heading source and the link set.
 */
function SidebarShell({ eyebrow, heading, tagline, renderBrand, children }: SidebarShellProps) {
  return (
    <aside className={styles.sidebar}>
      {renderBrand(
        <>
          <span className={styles.sectionLabel}>{eyebrow}</span>
          <h1 className={styles.logo}>{heading}</h1>
          {tagline && <p className={styles.tagline}>{tagline}</p>}
        </>,
      )}
      <nav className={styles.nav}>{children}</nav>
    </aside>
  )
}

/**
 * The system tab's sidebar: everything that belongs to the installation rather
 * than to any one project. No project navigation appears here — a project lives
 * in its own tab, and mixing the two is what made the old single-window shell
 * ambiguous about what "here" meant.
 */
export function SystemSidebar() {
  const { t } = useTranslation()

  return (
    <SidebarShell
      eyebrow={t('nav.system')}
      heading={t('app.title')}
      tagline={t('app.subtitle')}
      renderBrand={(content) => (
        <Link to="/library" className={styles.brand}>
          {content}
        </Link>
      )}
    >
      <Link
        to="/library"
        className={styles.navItem}
        activeProps={{ 'aria-current': 'page' }}
        activeOptions={{ exact: false }}
      >
        {t('nav.library')}
      </Link>
      <Link to="/ssh-keys" className={styles.navItem} activeProps={{ 'aria-current': 'page' }}>
        {t('nav.sshKeys')}
      </Link>
      <Link to="/settings" className={styles.navItem} activeProps={{ 'aria-current': 'page' }}>
        {t('nav.configuration')}
      </Link>
    </SidebarShell>
  )
}

/**
 * A project tab's sidebar: that project, and nothing else.
 *
 * The heading is the project's name because the tab label is small and a tab
 * row full of similar names is easy to misread — the sidebar is where you
 * confirm which checkout you are about to run an agent against.
 */
export function ProjectSidebar({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data: projects } = useProjects()
  const project = projects?.find((candidate) => candidate.id === projectId)

  return (
    <SidebarShell
      eyebrow={t('nav.project')}
      // Loading and gone are different things to say: a tab restored from a
      // deep link to a deleted project should not sit there saying it is
      // still fetching something.
      heading={project?.name ?? (projects ? t('tabs.unknown') : t('tabs.loading'))}
      tagline={project?.path}
      renderBrand={(content) => <div className={styles.brand}>{content}</div>}
    >
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className={styles.navItem}
        activeProps={{ 'aria-current': 'page' }}
        activeOptions={{ exact: true }}
      >
        {t('nav.overview')}
      </Link>
      <Link
        to="/projects/$projectId/sessions"
        params={{ projectId }}
        className={styles.navItem}
        activeProps={{ 'aria-current': 'page' }}
      >
        {t('nav.sessions')}
      </Link>
      <Link
        to="/projects/$projectId/library"
        params={{ projectId }}
        className={styles.navItem}
        activeProps={{ 'aria-current': 'page' }}
      >
        {t('nav.projectLibrary')}
      </Link>
    </SidebarShell>
  )
}
