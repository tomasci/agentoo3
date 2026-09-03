import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Field,
  Inline,
  Input,
  NumberInput,
  PageHeader,
  Select,
  type SelectOption,
  Spinner,
  Stack,
  Switch,
  Textarea,
} from '@/shared/ui'
import { useAgent, useCreateAgent, useDeleteAgent, useUpdateAgent } from '../hooks/use-library'
import { AVAILABLE_TOOLS, EFFORTS, MODELS } from '../model/tools'
import styles from './library.module.scss'

interface Draft {
  name: string
  role: 'orchestrator' | 'subagent'
  team: boolean
  description: string
  model: string
  effort: string
  maxTurns: number | null
  tools: string[]
  restrictTools: boolean
  prompt: string
}

const EMPTY: Draft = {
  name: '',
  role: 'subagent',
  team: true,
  description: '',
  model: '',
  effort: '',
  maxTurns: null,
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
      team: agent.team,
      description: agent.description,
      model: agent.model ?? '',
      effort: agent.effort ?? '',
      maxTurns: agent.maxTurns ?? null,
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
    // Only an orchestrator leads a team. Sending the flag for a subagent would
    // write a field into its file that means nothing there.
    ...(draft.role === 'orchestrator' ? { team: draft.team } : {}),
    description: draft.description,
    prompt: draft.prompt,
    ...(draft.restrictTools ? { tools: draft.tools } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort as 'low' } : {}),
    ...(draft.maxTurns != null ? { maxTurns: draft.maxTurns } : {}),
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
      // A changed name is a rename: the file moves and every project's symlink
      // is rebuilt to follow it.
      update.mutate(
        { path: { name }, body: { ...body, ...(draft.name !== name ? { name: draft.name } : {}) } },
        { onSuccess: () => void navigate({ to: '/library' }), onError },
      )
    }
  }

  const busy = create.isPending || update.isPending
  if (!isNew && isPending) return <Spinner label={t('common.loading')} block />

  const roleOptions: SelectOption[] = [
    {
      value: 'subagent',
      label: t('library.role.subagent'),
      description: t('library.roleHint.subagent'),
    },
    {
      value: 'orchestrator',
      label: t('library.role.orchestrator'),
      description: t('library.roleHint.orchestrator'),
    },
  ]
  const modelOptions: SelectOption[] = MODELS.map((m) => ({
    value: m,
    label: m || t('library.agent.inherit'),
  }))
  const effortOptions: SelectOption[] = EFFORTS.map((e2) => ({
    value: e2,
    label: e2 || t('library.agent.default'),
  }))

  return (
    <Stack gap={5}>
      <Link to="/library" className={styles.back}>
        ← {t('library.backToLibrary')}
      </Link>

      <PageHeader title={isNew ? t('library.newAgent') : draft.name || name} />

      <Card>
        <div className={styles.grid}>
          <Field
            label={t('library.agent.name')}
            hint={isNew ? t('library.agent.nameHint') : t('library.agent.renameHint')}
          >
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="reviewer"
            />
          </Field>

          <Field label={t('library.agent.role')} hint={t(`library.roleHint.${draft.role}`)}>
            <Select
              options={roleOptions}
              value={draft.role}
              onValueChange={(v) => set('role', (v ?? 'subagent') as Draft['role'])}
            />
          </Field>

          {draft.role === 'orchestrator' && (
            <Switch
              label={t('library.agent.team')}
              description={t(`library.agent.teamHint.${draft.team ? 'on' : 'off'}`)}
              checked={draft.team}
              onCheckedChange={(checked) => set('team', checked)}
            />
          )}

          <Field label={t('library.agent.model')}>
            <Select
              options={modelOptions}
              value={draft.model}
              onValueChange={(v) => set('model', v ?? '')}
            />
          </Field>

          <Field label={t('library.agent.effort')}>
            <Select
              options={effortOptions}
              value={draft.effort}
              onValueChange={(v) => set('effort', v ?? '')}
            />
          </Field>

          <Field label={t('library.agent.maxTurns')} hint={t('library.agent.unlimited')}>
            <NumberInput value={draft.maxTurns} onValueChange={(v) => set('maxTurns', v)} min={1} />
          </Field>
        </div>

        <Field label={t('library.agent.description')} hint={t('library.agent.descriptionHint')}>
          <Input
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('library.agent.descriptionPlaceholder')}
          />
        </Field>
      </Card>

      <Card>
        <Stack gap={3}>
          <Checkbox
            label={t('library.agent.restrictTools')}
            description={t('library.agent.toolsHint')}
            checked={draft.restrictTools}
            onCheckedChange={(checked) => set('restrictTools', checked)}
          />
          {draft.restrictTools && (
            <div className={styles.tools}>
              {AVAILABLE_TOOLS.map((tool) => (
                <Checkbox
                  key={tool}
                  label={tool}
                  checked={draft.tools.includes(tool)}
                  onCheckedChange={(checked) =>
                    set(
                      'tools',
                      checked ? [...draft.tools, tool] : draft.tools.filter((x) => x !== tool),
                    )
                  }
                />
              ))}
            </div>
          )}
        </Stack>
      </Card>

      <Field
        label={t('library.agent.prompt')}
        hint={
          draft.role === 'orchestrator'
            ? t('library.agent.promptHintOrchestrator')
            : t('library.agent.promptHint')
        }
      >
        <Textarea
          mono
          rows={20}
          value={draft.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          spellCheck={false}
          placeholder={t('library.agent.promptPlaceholder')}
        />
      </Field>

      <Stack gap={3}>
        {error && <Alert>{error}</Alert>}
        <Inline gap={2}>
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
        </Inline>
      </Stack>

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
    </Stack>
  )
}
