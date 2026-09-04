import { useTranslation } from 'react-i18next'
import { Alert, Card, EmptyState, PageHeader, Spinner, Stack } from '@/shared/ui'
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
      <Stack gap={8}>
        <PageHeader title={t('picker.heading')} description={t('picker.lead')} />

        <Card>
          <Stack gap={3}>
            <PageHeader level={2} title={t('picker.existing')} />

            {isError && <Alert>{apiErrorMessage(error, t('projects.loadFailed'))}</Alert>}
            {!isError && isPending && <Spinner label={t('common.loading')} block />}
            {!isError && !isPending && projects.length === 0 && (
              <EmptyState title={t('picker.none')} />
            )}
            {projects.length > 0 && <ProjectsTable projects={projects} onOpen={onPick} />}
          </Stack>
        </Card>

        <Card>
          <Stack gap={3}>
            <PageHeader level={2} title={t('picker.create')} />
            {/* Creating opens the project in this tab straight away: a clone shows
                its progress on the overview, which is the page you would go looking
                for it on anyway. */}
            <CreateProjectForm onCreated={onPick} />
          </Stack>
        </Card>
      </Stack>
    </div>
  )
}
