import { Link } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { DefinitionList, Loading, StatusBadge, toast } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Spinner } from '@/shared/ui/spinner'
import { useLearningOverview, useRunLearningNow } from '../hooks/use-learning'
import { formatDateTime, formatTimezone } from '../lib/format'

/**
 * The Suggested view's own panel: the schedule, a manual "Run learning now",
 * the run currently in flight (if any) and the last one that finished.
 * `useLearningOverview` owns the polling cadence and the "a run just
 * finished" invalidation — this only renders what it returns.
 */
export function LearningPanel() {
  const { t } = useTranslation()
  const overview = useLearningOverview()
  const run = useRunLearningNow()

  const data = overview.data
  const active = data?.activeRun ?? null
  const lastRun = data?.lastRun ?? null
  const schedule = data?.schedule

  const runNow = () => {
    run.mutate(undefined, {
      onError: (e) => {
        toast.add({ title: apiErrorMessage(e, t('library.learning.runFailed')), type: 'error' })
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('library.learning.heading')}</CardTitle>
        {schedule && (
          <CardDescription>
            {schedule.value.enabled
              ? t('library.learning.scheduleOn', {
                  time: schedule.value.time,
                  timezone: formatTimezone(schedule.value.timezone),
                })
              : t('library.learning.scheduleOff')}{' '}
            <Link to="/settings" className="underline underline-offset-4 hover:no-underline">
              {t('library.learning.scheduleLink')}
            </Link>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {overview.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(overview.error, t('library.learning.loadFailed'))}
            </AlertDescription>
          </Alert>
        )}
        {overview.isPending && <Loading label={t('common.loading')} />}
        {!overview.isPending && !overview.isError && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={Boolean(active) || run.isPending} onClick={runNow}>
                {run.isPending && <Spinner data-icon="inline-start" />}
                {t('library.learning.runNow')}
              </Button>
              {active && (
                <StatusBadge tone="accent" pulse={active.status === 'running'}>
                  {active.status === 'queued'
                    ? t('library.learning.runQueued')
                    : t('library.learning.runRunning', {
                        start: formatDateTime(active.windowStart),
                        end: formatDateTime(active.windowEnd),
                      })}
                </StatusBadge>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">
                {t('library.learning.lastRun')}
              </h3>
              {!lastRun && (
                <p className="text-sm text-muted-foreground">{t('library.learning.noRuns')}</p>
              )}
              {lastRun && (
                <>
                  <DefinitionList
                    items={[
                      {
                        id: 'when',
                        term: t('library.learning.lastRunWhen'),
                        description: formatDateTime(lastRun.finishedAt ?? lastRun.createdAt),
                      },
                      {
                        id: 'sessions',
                        term: t('library.learning.lastRunSessions'),
                        description: lastRun.sessionsAnalyzed,
                      },
                      {
                        id: 'created',
                        term: t('library.learning.lastRunCreated'),
                        description: lastRun.suggestionsCreated,
                      },
                      {
                        id: 'duplicates',
                        term: t('library.learning.lastRunDuplicates'),
                        description: lastRun.duplicatesSkipped,
                      },
                      {
                        id: 'cost',
                        term: t('library.learning.lastRunCost'),
                        description: `$${lastRun.costUsd.toFixed(2)}`,
                      },
                    ]}
                  />
                  {lastRun.error && (
                    // `failed` keeps the destructive styling an actual failure
                    // earns; `completed` can still carry an advisory note (a
                    // budget cutoff, one batch of a run failing) that is not
                    // itself a failure, so it gets the same Alert shape
                    // without the alarming colour.
                    <Alert variant={lastRun.status === 'failed' ? 'destructive' : 'default'}>
                      <CircleAlertIcon />
                      <AlertTitle>
                        {lastRun.status === 'failed'
                          ? t('library.learning.lastRunError')
                          : t('library.learning.lastRunNote')}
                      </AlertTitle>
                      <AlertDescription>{lastRun.error}</AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </div>

            {schedule?.nextRunAt && (
              <p className="text-sm text-muted-foreground">
                {t('library.learning.scheduleNextRun', {
                  when: formatDateTime(schedule.nextRunAt),
                })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
