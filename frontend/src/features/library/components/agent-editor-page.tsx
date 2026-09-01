import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Button, ConfirmDialog } from '@/shared/ui'
import { useAgent, useCreateAgent, useDeleteAgent, useUpdateAgent } from '../hooks/use-library'
import { AVAILABLE_TOOLS, EFFORTS, MODELS } from '../model/tools'
import styles from './library.module.scss'

interface Draft {
  name: string
  role: 'orchestrator' | 'subagent'
  description: string
  model: string
  effort: string
  maxTurns: string
  tools: string[]
  restrictTools: boolean
  prompt: string
}

const EMPTY: Draft = {
  name: '',
  role: 'subagent',
  description: '',
  model: '',
  effort: '',
  maxTurns: '',
  tools: [],
  restrictTools: false,
  prompt: '',
}

/** Create or edit one agent. `name` absent means create. */
export function AgentEditorPage({ name }: { name?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isNew = !name
  const { data: agent, isPending } = useAgent(name ?? '')
  const create = useCreateAgent()
  const update = useUpdateAgent()
  const remove = useDeleteAgent()

  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!agent) return
    setDraft({
      name: agent.name,
      role: agent.role,
      description: agent.description,
      model: agent.model ?? '',
      effort: agent.effort ?? '',
      maxTurns: agent.maxTurns ? String(agent.maxTurns) : '',
      // An agent with no `tools` inherits everything; the checkboxes only mean
      // something once you opt into restricting it.
      tools: agent.tools ?? [],
      restrictTools: Array.isArray(agent.tools),
      prompt: agent.prompt,
    })
  }, [agent])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const body = {
    role: draft.role,
    description: draft.description,
    prompt: draft.prompt,
    ...(draft.restrictTools ? { tools: draft.tools } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort as 'low' } : {}),
    ...(draft.maxTurns ? { maxTurns: Number(draft.maxTurns) } : {}),
  }

  const save = () => {
    setError(null)
    const onError = (e: unknown) => setError(apiErrorMessage(e, t('library.saveFailed')))
    if (isNew) {
      create.mutate(
        { body: { name: draft.name, ...body } },
        { onSuccess: () => void navigate({ to: '/library' }), onError },
      )
    } else {
      update.mutate(
        { path: { name }, body },
        { onSuccess: () => void navigate({ to: '/library' }), onError },
      )
    }
  }

  const busy = create.isPending || update.isPending
  if (!isNew && isPending) return <p>{t('common.loading')}</p>

  return (
    <div className={styles.editor}>
      <Link to="/library" className={styles.back}>
        ← {t('library.backToLibrary')}
      </Link>

      <section className={styles.card}>
        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="agent-name">
              {t('library.agent.name')}
            </label>
            <input
              id="agent-name"
              className={styles.input}
              value={draft.name}
              // The name is the filename; renaming would mean moving the file
              // and rewriting every project's symlink, so it is fixed once set.
              disabled={!isNew}
              onChange={(e) => set('name', e.target.value)}
              placeholder="reviewer"
            />
            {isNew && <span className={styles.hint}>{t('library.agent.nameHint')}</span>}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="agent-role">
              {t('library.agent.role')}
            </label>
            <select
              id="agent-role"
              className={styles.select}
              value={draft.role}
              onChange={(e) => set('role', e.target.value as Draft['role'])}
            >
              <option value="subagent">{t('library.role.subagent')}</option>
              <option value="orchestrator">{t('library.role.orchestrator')}</option>
            </select>
            <span className={styles.hint}>{t(`library.roleHint.${draft.role}`)}</span>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="agent-model">
              {t('library.agent.model')}
            </label>
            <select
              id="agent-model"
              className={styles.select}
              value={draft.model}
              onChange={(e) => set('model', e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m || t('library.agent.inherit')}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="agent-effort">
              {t('library.agent.effort')}
            </label>
            <select
              id="agent-effort"
              className={styles.select}
              value={draft.effort}
              onChange={(e) => set('effort', e.target.value)}
            >
              {EFFORTS.map((e2) => (
                <option key={e2} value={e2}>
                  {e2 || t('library.agent.default')}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="agent-turns">
              {t('library.agent.maxTurns')}
            </label>
            <input
              id="agent-turns"
              className={styles.input}
              type="number"
              min="1"
              value={draft.maxTurns}
              onChange={(e) => set('maxTurns', e.target.value)}
              placeholder={t('library.agent.unlimited')}
            />
          </div>
        </div>

        <div className={styles.field} style={{ marginTop: '0.75rem' }}>
          <label className={styles.label} htmlFor="agent-desc">
            {t('library.agent.description')}
          </label>
          <input
            id="agent-desc"
            className={styles.input}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('library.agent.descriptionPlaceholder')}
          />
          <span className={styles.hint}>{t('library.agent.descriptionHint')}</span>
        </div>
      </section>

      <section className={styles.card}>
        <label className={styles.tool} style={{ marginBottom: '0.5rem' }}>
          <input
            type="checkbox"
            checked={draft.restrictTools}
            onChange={(e) => set('restrictTools', e.target.checked)}
          />
          {t('library.agent.restrictTools')}
        </label>
        <p className={styles.hint}>{t('library.agent.toolsHint')}</p>
        {draft.restrictTools && (
          <div className={styles.tools} style={{ marginTop: '0.75rem' }}>
            {AVAILABLE_TOOLS.map((tool) => (
              <label key={tool} className={styles.tool}>
                <input
                  type="checkbox"
                  checked={draft.tools.includes(tool)}
                  onChange={(e) =>
                    set(
                      'tools',
                      e.target.checked
                        ? [...draft.tools, tool]
                        : draft.tools.filter((x) => x !== tool),
                    )
                  }
                />
                {tool}
              </label>
            ))}
          </div>
        )}
      </section>

      <section className={styles.field}>
        <label className={styles.label} htmlFor="agent-prompt">
          {t('library.agent.prompt')}
        </label>
        <textarea
          id="agent-prompt"
          className={styles.prompt}
          value={draft.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          spellCheck={false}
          placeholder={t('library.agent.promptPlaceholder')}
        />
        <span className={styles.hint}>
          {draft.role === 'orchestrator'
            ? t('library.agent.promptHintOrchestrator')
            : t('library.agent.promptHint')}
        </span>
      </section>

      <div className={styles.controls}>
        <Button
          type="button"
          disabled={busy || !draft.name || !draft.description || !draft.prompt}
          onClick={save}
        >
          {busy ? t('common.working') : t('common.save')}
        </Button>
        {!isNew && (
          <Button type="button" onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        )}
        {error && <span className={styles.error}>{error}</span>}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('library.agent.deleteTitle')}
        description={t('library.agent.deleteConfirm', { name })}
        busy={remove.isPending}
        onConfirm={() =>
          name &&
          remove.mutate({ path: { name } }, { onSuccess: () => void navigate({ to: '/library' }) })
        }
      />
    </div>
  )
}
