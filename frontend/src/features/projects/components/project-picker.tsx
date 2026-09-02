import { useTranslation } from 'react-i18next'
import { useProjects } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { CreateProjectForm } from './create-project-form'
import styles from './project-picker.module.scss'
import { ProjectsTable } from './projects-table'

/**
 * What an empty tab shows: pick a project for this tab, or add one.
 *
 * The same table and the same form as before, because this is the screen people
 * already know — what changed is where a choice lands. Picking fills in *this*
 * tab; a project already open elsewhere takes you to the tab holding it rather
 * than opening the same checkout twice.
 */
export function ProjectPicker({ onPick }: { onPick: (projectId: string) => void }) {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useProjects()
  const projects = data ?? []

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h2 className={styles.title}>{t('picker.heading')}</h2>
        <p className={styles.lead}>{t('picker.lead')}</p>
      </header>

      <section>
        <h3 className={styles.sectionTitle}>{t('picker.existing')}</h3>

        {isError && (
          <p className={styles.problem}>
            {t('projects.loadFailed')} — {apiErrorMessage(error, t('projects.loadFailed'))}
          </p>
        )}

        {isPending && <p className={styles.empty}>{t('common.loading')}</p>}

        {!isPending && !isError && projects.length === 0 && (
          <p className={styles.empty}>{t('picker.none')}</p>
        )}

        {projects.length > 0 && <ProjectsTable projects={projects} onOpen={onPick} />}
      </section>

      <section>
        <h3 className={styles.sectionTitle}>{t('picker.create')}</h3>
        {/* Creating opens the project in this tab straight away: a clone shows
            its progress on the overview, which is the page you would go looking
            for it on anyway. */}
        <CreateProjectForm onCreated={onPick} />
      </section>
    </div>
  )
}
