import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useProjects } from '@/features/projects'
import styles from './layout.module.scss'

/**
 * The system tab's sidebar: everything that belongs to the installation rather
 * than to any one project. No project navigation appears here — a project lives
 * in its own tab, and mixing the two is what made the old single-window shell
 * ambiguous about what "here" meant.
 */
export function SystemSidebar() {
  const { t } = useTranslation()

  return (
    <aside className={styles.sidebar}>
      <Link to="/library" className={styles.brand}>
        <h1 className={styles.logo}>{t('app.title')}</h1>
        <p className={styles.tagline}>{t('app.subtitle')}</p>
      </Link>

      <div className={styles.sidebarSection}>
        <span className={styles.sectionLabel}>{t('nav.system')}</span>
        <nav className={styles.nav}>
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
        </nav>
      </div>
    </aside>
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
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.sectionLabel}>{t('nav.project')}</span>
        {/* Loading and gone are different things to say: a tab restored from a
            deep link to a deleted project should not sit there saying it is
            still fetching something. */}
        <h1 className={styles.logo}>
          {project?.name ?? (projects ? t('tabs.unknown') : t('tabs.loading'))}
        </h1>
        {project && <p className={styles.tagline}>{project.path}</p>}
      </div>

      <nav className={styles.nav}>
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
      </nav>
    </aside>
  )
}
