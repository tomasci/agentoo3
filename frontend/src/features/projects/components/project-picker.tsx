import { useTranslation } from 'react-i18next'
import { Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { useProjects } from '../hooks/use-projects'
import { apiErrorMessage } from '../lib/api-error'
import { CreateProjectForm } from './create-project-form'
import { ProjectsTable } from './projects-table'

/**
 * What an empty tab shows: pick a project for this tab, or add one.
 *
 * The same table and the same form as before, because this is the screen people
 * already know — what changed is where a choice lands. Picking fills in *this*
 * tab; a project already open elsewhere takes you to the tab holding it rather
 * than opening the same checkout twice.
 *
 * The page owns the whole width of an empty tab, so it centres on a readable
 * measure rather than stretching across an ultrawide monitor once there is
 * room to — full width below `sm`, capped and centred at and above it.
 */
export function ProjectPicker({ onPick }: { onPick: (projectId: string) => void }) {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useProjects()
  const projects = data ?? []

  return (
    <div className="sm:mx-auto sm:max-w-[52rem]">
      <div className="flex flex-col gap-8">
        <PageHeader title={t('picker.heading')} description={t('picker.lead')} />

        <Card>
          <CardHeader>
            <CardTitle>{t('picker.existing')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {isError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {apiErrorMessage(error, t('projects.loadFailed'))}
                </AlertDescription>
              </Alert>
            )}
            {!isError && isPending && <Loading label={t('common.loading')} block />}
            {!isError && !isPending && projects.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('picker.none')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
            {projects.length > 0 && <ProjectsTable projects={projects} onOpen={onPick} />}
          </CardContent>
        </Card>

        {/* `CreateProjectForm` renders its own `Card` and its own heading
            ("Add a project", `projects.form.heading` — the same text
            `picker.create` used to say a second time): wrapping it in another
            `Card` here produced a card inside a card with that title twice.
            Creating opens the project in this tab straight away: a clone
            shows its progress on the overview, which is the page you would go
            looking for it on anyway. */}
        <CreateProjectForm onCreated={onPick} />
      </div>
    </div>
  )
}
