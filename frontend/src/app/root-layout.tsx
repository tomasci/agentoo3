import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtomValue } from 'jotai'
import { useEffect } from 'react'
import { projectIdForPath, shellModeForPath } from '@/shared/store/tabs'
import { themeAtom } from '@/shared/store/ui'
import styles from './layout.module.scss'
import { ProjectSidebar, SystemSidebar } from './sidebar'
import { StatusBar } from './status-bar'
import { TabBar } from './tab-bar'
import { useWorkspaceSync } from './use-tabs'

export function RootLayout() {
  const theme = useAtomValue(themeAtom)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Mounted here, once: the workspace is kept in step with the URL on every
  // page, not only while the tab bar happens to be looking.
  useWorkspaceSync()

  const { pathname } = useLocation()
  const mode = shellModeForPath(pathname)
  const projectId = projectIdForPath(pathname)

  // An empty tab has nothing to navigate yet: until it is pointed at a project,
  // the picker gets the whole width rather than a sidebar of dead links.
  const withoutSidebar = mode === 'new'

  return (
    <div className={`${styles.shell} ${withoutSidebar ? styles.shellBare : ''}`}>
      <TabBar />

      {mode === 'project' && projectId && <ProjectSidebar projectId={projectId} />}
      {mode === 'system' && <SystemSidebar />}

      <main className={styles.body}>
        <Outlet />
      </main>

      <StatusBar />
    </div>
  )
}
