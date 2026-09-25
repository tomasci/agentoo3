import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { useProjects } from '@/features/projects'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Loading } from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { useCreateSession, useSessions } from '../hooks/use-sessions'
import { SessionCard } from './session-card'

export function ProjectSessions({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { data: projects } = useProjects()
  const { data: sessions, isPending, isError, error } = useSessions(projectId)
  const { data: agents } = useAgents()
  const create = useCreateSession(projectId)

  const [title, setTitle] = useState('')
  const [orchestrator, setOrchestrator] = useState('')
  const [budget, setBudget] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const titleId = useId()
  const baseBranchId = useId()
  const orchestratorId = useId()
  const budgetId = useId()

  const project = (projects ?? []).find((p) => p.id === projectId)

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  // An explicit "(none)" option, not a placeholder: the reader needs to be able
  // to pick their way back to no orchestrator, not just start there.
  const orchestratorOptions = [
    {
      value: '',
      label: t('sessions.form.orchestratorNone'),
      description: undefined as string | undefined,
    },
    // Just the name in the trigger's own label: a long unbroken orchestrator
    // name is demoted to the item's own description line instead, shown only
    // inside the open list.
    ...orchestrators.map((a) => ({ value: a.name, label: a.name, description: a.description })),
  ]

  const trimmedBaseBranch = baseBranch.trim()
  // The placeholder and the hint say the same thing two ways: an empty
  // field always means "the project's default, or the checkout's current
  // branch if there isn't one" — never a value this form invents itself.
  const baseBranchPlaceholder = project?.defaultBranch ?? t('sessions.form.baseBranchCurrent')
  const baseBranchHint = trimmedBaseBranch
    ? t('sessions.form.baseBranchWillUseOverride', { branch: trimmedBaseBranch })
    : project?.defaultBranch
      ? t('sessions.form.baseBranchWillUseDefault', { branch: project.defaultBranch })
      : t('sessions.form.baseBranchWillUseAuto')

  const onCreate = () => {
    setFormError(null)
    create.mutate(
      {
        path: { id: projectId },
        body: {
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(orchestrator ? { orchestrator } : {}),
          ...(budget ? { maxBudgetUsd: Number(budget) } : {}),
          ...(trimmedBaseBranch ? { baseBranch: trimmedBaseBranch } : {}),
        },
      },
      {
        onSuccess: () => {
          setTitle('')
          setBudget('')
          setBaseBranch('')
        },
        onError: (e) => setFormError(apiErrorMessage(e, t('sessions.createFailed'))),
      },
    )
  }

  return (
    // The root grid has no explicit columns, so its single `auto` track
    // grows to the widest child's min-content width — a session card's
    // working-dir path (`Code wrap` only wraps lines, it doesn't shrink
    // min-content) pushed that past a phone's viewport. `grid-cols-1`'s
    // `minmax(0, 1fr)` caps the column at the container's own width instead.
    <div className="grid grid-cols-1 gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('sessions.form.heading')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-xl flex-col gap-3">
            <Field>
              <FieldLabel htmlFor={titleId}>{t('sessions.form.title')}</FieldLabel>
              <Input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('sessions.form.titlePlaceholder')}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={baseBranchId}>{t('sessions.form.baseBranch')}</FieldLabel>
              <Input
                id={baseBranchId}
                className="font-mono"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder={baseBranchPlaceholder}
              />
              <FieldDescription>{baseBranchHint}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={orchestratorId}>{t('sessions.form.orchestrator')}</FieldLabel>
              <Select
                items={orchestratorOptions}
                value={orchestrator}
                onValueChange={(value) => setOrchestrator(value ?? '')}
              >
                <SelectTrigger id={orchestratorId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {orchestratorOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <div className="flex flex-col">
                        <span>{option.label}</span>
                        {option.description && (
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {orchestrators.length === 0
                  ? t('sessions.form.orchestratorEmpty')
                  : t('sessions.form.orchestratorHint')}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={budgetId}>{t('sessions.form.budget')}</FieldLabel>
              <Input
                id={budgetId}
                type="number"
                min="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="10"
              />
              <FieldDescription>{t('sessions.form.budgetHint')}</FieldDescription>
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={create.isPending || project?.status !== 'ready'}
                onClick={onCreate}
              >
                {create.isPending ? t('sessions.form.creating') : t('sessions.form.submit')}
              </Button>
              {project && project.status !== 'ready' && (
                <span className="text-xs text-muted-foreground">{t('sessions.form.notReady')}</span>
              )}
            </div>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-base font-semibold">{t('sessions.heading')}</h3>
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
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(26rem,100%),1fr))]">
            {(sessions ?? []).map((s) => (
              <SessionCard key={s.id} session={s} projectId={projectId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
