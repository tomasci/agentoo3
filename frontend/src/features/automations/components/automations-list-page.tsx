import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { type Automation, useAutomations } from '../hooks/use-automations'
import { AutomationFormDialog } from './automation-form-dialog'
import { AutomationsTable } from './automations-table'

/**
 * The project's automations: an always-visible list (paused ones stay on
 * it, same as the brief's own "paused but visible and editable" rule), a
 * create button, and one shared edit dialog reused for whichever row's
 * "Edit" was last clicked — the same one-dialog-many-rows shape
 * `ProjectLibraryPage` and `SessionsTable`'s delete confirm use.
 */
export function AutomationsListPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data: automations, isPending, isError, error } = useAutomations(projectId)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<Automation | null>(null)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('automations.heading')}
        description={t('automations.lead')}
        actions={
          <Button type="button" onClick={() => setShowCreate(true)}>
            {t('automations.newAutomation')}
          </Button>
        }
      />

      {isError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{apiErrorMessage(error, t('automations.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {isPending && <Loading label={t('common.loading')} block />}
      {!isPending && !isError && (automations ?? []).length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('automations.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {!isPending && !isError && (automations ?? []).length > 0 && (
        <AutomationsTable
          automations={automations ?? []}
          projectId={projectId}
          onEdit={setEditing}
        />
      )}

      <AutomationFormDialog projectId={projectId} open={showCreate} onOpenChange={setShowCreate} />
      <AutomationFormDialog
        projectId={projectId}
        automation={editing ?? undefined}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </div>
  )
}
