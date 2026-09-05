import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { useProjects } from '@/features/projects'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Inline,
  Input,
  Select,
  type SelectOption,
  Spinner,
  Stack,
} from '@/shared/ui'
import { useCreateSession, useSessions } from '../hooks/use-sessions'
import { SessionCard } from './session-card'
import styles from './sessions.module.scss'

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

  const project = (projects ?? []).find((p) => p.id === projectId)

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  // An explicit "(none)" option, not a placeholder: the reader needs to be able
  // to pick their way back to no orchestrator, not just start there.
  const orchestratorOptions: SelectOption[] = [
    { value: '', label: t('sessions.form.orchestratorNone') },
    // Just the name in the trigger's own label: the select trigger has no
    // min-width:0 defence against a long unbroken string (that fix belongs to
    // Select, not this call site — see the report), so the description is
    // demoted to SelectOption.description, shown only inside the open list.
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
    <div className={styles.page}>
      <Card variant="dashed">
        <div className={styles.form}>
          <Stack gap={3}>
            <h3 className={styles.heading}>{t('sessions.form.heading')}</h3>

            <Field label={t('sessions.form.title')}>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('sessions.form.titlePlaceholder')}
              />
            </Field>

            <Field label={t('sessions.form.baseBranch')} hint={baseBranchHint}>
              <Input
                mono
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder={baseBranchPlaceholder}
              />
            </Field>

            <Field
              label={t('sessions.form.orchestrator')}
              hint={
                orchestrators.length === 0
                  ? t('sessions.form.orchestratorEmpty')
                  : t('sessions.form.orchestratorHint')
              }
            >
              <Select
                options={orchestratorOptions}
                value={orchestrator}
                onValueChange={(value) => setOrchestrator(value ?? '')}
              />
            </Field>

            <Field label={t('sessions.form.budget')} hint={t('sessions.form.budgetHint')}>
              <Input
                type="number"
                min="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="10"
              />
            </Field>

            <Inline gap={3}>
              <Button
                type="button"
                disabled={create.isPending || project?.status !== 'ready'}
                onClick={onCreate}
              >
                {create.isPending ? t('sessions.form.creating') : t('sessions.form.submit')}
              </Button>
              {project && project.status !== 'ready' && (
                <span className={styles.hint}>{t('sessions.form.notReady')}</span>
              )}
            </Inline>
            {formError && <Alert tone="danger">{formError}</Alert>}
          </Stack>
        </div>
      </Card>

      <div>
        <h3 className={styles.heading}>{t('sessions.heading')}</h3>
        {isError && <Alert tone="danger">{apiErrorMessage(error, t('sessions.loadFailed'))}</Alert>}
        {isPending && <Spinner label={t('common.loading')} block />}
        {!isPending && !isError && (sessions ?? []).length === 0 && (
          <EmptyState title={t('sessions.empty')} />
        )}
        {(sessions ?? []).length > 0 && (
          <div className={styles.list}>
            {(sessions ?? []).map((s) => (
              <SessionCard key={s.id} session={s} projectId={projectId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
