import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { useProjects } from '@/features/projects'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button } from '@/shared/ui'
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
  const [formError, setFormError] = useState<string | null>(null)

  const project = (projects ?? []).find((p) => p.id === projectId)

  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')

  const onCreate = () => {
    setFormError(null)
    create.mutate(
      {
        path: { id: projectId },
        body: {
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(orchestrator ? { orchestrator } : {}),
          ...(budget ? { maxBudgetUsd: Number(budget) } : {}),
        },
      },
      {
        onSuccess: () => {
          setTitle('')
          setBudget('')
        },
        onError: (e) => setFormError(apiErrorMessage(e, t('sessions.createFailed'))),
      },
    )
  }

  return (
    <div className={styles.page}>
      <section className={styles.formCard}>
        <h3 className={styles.heading}>{t('sessions.form.heading')}</h3>
        <div className={styles.form}>
          <label className={styles.label} htmlFor="session-title">
            {t('sessions.form.title')}
          </label>
          <input
            id="session-title"
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('sessions.form.titlePlaceholder')}
          />

          <label className={styles.label} htmlFor="session-orchestrator">
            {t('sessions.form.orchestrator')}
          </label>
          <select
            id="session-orchestrator"
            className={styles.input}
            value={orchestrator}
            onChange={(e) => setOrchestrator(e.target.value)}
          >
            <option value="">{t('sessions.form.orchestratorNone')}</option>
            {orchestrators.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} — {a.description}
              </option>
            ))}
          </select>
          <span className={styles.hint}>
            {orchestrators.length === 0
              ? t('sessions.form.orchestratorEmpty')
              : t('sessions.form.orchestratorHint')}
          </span>

          <label className={styles.label} htmlFor="session-budget">
            {t('sessions.form.budget')}
          </label>
          <input
            id="session-budget"
            className={styles.input}
            type="number"
            min="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="10"
          />
          <span className={styles.hint}>{t('sessions.form.budgetHint')}</span>

          <div className={styles.row}>
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
            {formError && <span className={styles.error}>{formError}</span>}
          </div>
        </div>
      </section>

      <p className={styles.notice}>{t('sessions.notImplemented')}</p>

      <div>
        <h3 className={styles.heading}>{t('sessions.heading')}</h3>
        {isError && (
          <p className={styles.error}>{apiErrorMessage(error, t('sessions.loadFailed'))}</p>
        )}
        {isPending && <p className={styles.empty}>{t('common.loading')}</p>}
        {!isPending && !isError && (sessions ?? []).length === 0 && (
          <p className={styles.empty}>{t('sessions.empty')}</p>
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
