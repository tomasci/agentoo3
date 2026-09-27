import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading, PageHeader } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { useSessions } from '../hooks/use-sessions'
import { NewSessionDialog } from './new-session-dialog'
import { SessionsTable } from './sessions-table'

export function ProjectSessions({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data: sessions, isPending, isError, error } = useSessions(projectId)
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('sessions.heading')}
        actions={
          <Button type="button" onClick={() => setShowCreate(true)}>
            {t('sessions.form.heading')}
          </Button>
        }
      />

      {isError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(error, t('sessions.loadFailed'))}</AlertDescription>
        </Alert>
      )}
      {isPending && <Loading label={t('common.loading')} block />}
      {!isPending && !isError && (sessions ?? []).length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('sessions.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {(sessions ?? []).length > 0 && (
        <SessionsTable sessions={sessions ?? []} projectId={projectId} />
      )}

      <NewSessionDialog projectId={projectId} open={showCreate} onOpenChange={setShowCreate} />
    </div>
  )
}
