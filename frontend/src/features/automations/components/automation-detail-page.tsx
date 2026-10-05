import { Link, useNavigate } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  ConfirmDialog,
  Loading,
  Markdown,
  PageHeader,
  StatusBadge,
  toast,
} from '@/shared/components'
import { zoneWithOffset } from '@/shared/lib/timezones'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Spinner } from '@/shared/ui/spinner'
import {
  useAutomation,
  useAutomationRuns,
  useDeleteAutomation,
  useUpdateAutomation,
} from '../hooks/use-automations'
import { formatInZone } from '../lib/format'
import { describeSchedule } from '../lib/schedule'
import { AUTOMATION_TONE, RUN_STATUS_TONE, SESSION_STATUS_TONE } from '../lib/status'
import { AutomationFormDialog } from './automation-form-dialog'

export function AutomationDetailPage({
  projectId,
  automationId,
}: {
  projectId: string
  automationId: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const automation = useAutomation(automationId)
  const runs = useAutomationRuns(automationId)
  const update = useUpdateAutomation(projectId)
  const remove = useDeleteAutomation(projectId)
  const [showEdit, setShowEdit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (automation.isPending) return <Loading label={t('common.loading')} block />
  if (automation.isError || !automation.data) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertDescription>
          {apiErrorMessage(automation.error, t('automations.notFound'))}
        </AlertDescription>
      </Alert>
    )
  }

  const data = automation.data

  const togglePaused = () =>
    update.mutate(
      { path: { id: data.id }, body: { paused: !data.paused } },
      {
        onError: (e) =>
          toast.add({
            type: 'error',
            title: apiErrorMessage(e, t('automations.table.pauseFailed')),
          }),
      },
    )

  const emptyRunsText =
    !data.paused && data.nextRunAt
      ? t('automations.runs.emptyWithNext', { when: formatInZone(data.nextRunAt, data.timezone) })
      : t('automations.runs.empty')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={data.name}
        eyebrow={
          <StatusBadge tone={AUTOMATION_TONE(data)}>
            {data.paused ? t('automations.paused') : t('automations.active')}
          </StatusBadge>
        }
        actions={
          <>
            <Link
              to="/projects/$projectId/automations"
              params={{ projectId }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('automations.detail.backToList')}
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={update.isPending}
              onClick={togglePaused}
            >
              {update.isPending && <Spinner data-icon="inline-start" />}
              {data.paused ? t('automations.resume') : t('automations.pause')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowEdit(true)}>
              {t('common.edit')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{describeSchedule(data.cron, t)}</span>
        <span>{zoneWithOffset(data.timezone)}</span>
        <span>
          {t('automations.detail.nextRun', {
            when: data.paused
              ? t('automations.paused')
              : data.nextRunAt
                ? formatInZone(data.nextRunAt, data.timezone)
                : t('automations.never'),
          })}
        </span>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <PageHeader level={2} title={t('automations.detail.promptHeading')} />
          <Markdown>{data.prompt}</Markdown>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <PageHeader level={2} title={t('automations.runs.heading')} />

          {runs.isError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>
                {apiErrorMessage(runs.error, t('automations.runs.loadFailed'))}
              </AlertDescription>
            </Alert>
          )}
          {runs.isPending && <Loading label={t('common.loading')} />}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{emptyRunsText}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}

          {!runs.isPending && !runs.isError && (runs.data ?? []).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {(runs.data ?? []).map((run) => (
                <li key={run.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusBadge tone={RUN_STATUS_TONE[run.status]}>
                      {t(`automations.runs.status.${run.status}`)}
                    </StatusBadge>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>
                        {t('automations.runs.scheduledFor')}:{' '}
                        {formatInZone(run.scheduledFor, data.timezone)}
                      </span>
                      <span>
                        {t('automations.runs.startedAt')}:{' '}
                        {formatInZone(run.startedAt, data.timezone)}
                      </span>
                    </div>
                  </div>

                  {run.status === 'failed' && run.error && (
                    <Alert variant="destructive">
                      <CircleAlertIcon />
                      <AlertDescription>{run.error}</AlertDescription>
                    </Alert>
                  )}

                  {run.session ? (
                    <Link
                      to="/projects/$projectId/sessions/$sessionId"
                      params={{ projectId, sessionId: run.session.id }}
                      className="flex flex-wrap items-center gap-2 rounded-md p-1 hover:bg-accent/50"
                    >
                      <span className="font-medium text-foreground">
                        {run.session.title ??
                          t('sessions.untitled', { id: run.session.id.slice(0, 8) })}
                      </span>
                      <StatusBadge tone={SESSION_STATUS_TONE[run.session.status]}>
                        {t(`sessions.status.${run.session.status}`)}
                      </StatusBadge>
                      <span className="text-xs text-muted-foreground">
                        ${run.session.totalCostUsd.toFixed(4)}
                      </span>
                      {run.session.unchecked && (
                        <StatusBadge tone="accent">{t('automations.runs.unchecked')}</StatusBadge>
                      )}
                    </Link>
                  ) : (
                    run.status === 'dispatched' && (
                      <span className="text-sm text-muted-foreground">
                        {t('automations.runs.sessionDeleted')}
                      </span>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AutomationFormDialog
        projectId={projectId}
        automation={data}
        open={showEdit}
        onOpenChange={setShowEdit}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('automations.delete.title')}
        description={t('automations.delete.confirm', { name: data.name })}
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { path: { id: data.id } },
            {
              onSuccess: () =>
                void navigate({ to: '/projects/$projectId/automations', params: { projectId } }),
              onError: (e) =>
                toast.add({
                  type: 'error',
                  title: apiErrorMessage(e, t('automations.delete.failed')),
                }),
              onSettled: () => setConfirmDelete(false),
            },
          )
        }
      />
    </div>
  )
}
