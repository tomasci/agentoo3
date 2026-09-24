import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, CircleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { ConfirmDialog, Loading, PageHeader } from '@/shared/components'
import { parseNumberInput } from '@/shared/lib/number-input'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'
import {
  useAgent,
  useCreateAgent,
  useDeleteAgent,
  useModels,
  useUpdateAgent,
} from '../hooks/use-library'
import { AVAILABLE_TOOLS, EFFORTS } from '../model/tools'

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
  const models = useModels()
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
  if ((!isNew && isPending) || models.isPending)
    return <Loading label={t('common.loading')} block />

  const roleOptions = [
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
  const modelOptions: { value: string; label: string; description?: string }[] = [
    { value: '', label: t('library.agent.default') },
    ...(models.data?.models ?? []).map((m) => ({
      value: m.value,
      label: m.displayName,
      description: m.description,
    })),
  ]
  // Only a subagent has a parent to inherit a model from; an orchestrator
  // drives its own session, so the option would mean nothing there. The API
  // never returns this value at all — it only ever comes from an agent's own
  // frontmatter.
  if (draft.role === 'subagent') {
    modelOptions.push({ value: 'inherit', label: t('library.agent.inherit') })
  }
  // The saved model can be one this list no longer has — retired since, hand-
  // edited, or written in a form (e.g. `opus[1m]`) this box's list doesn't
  // currently carry — so it stays selectable, labelled with the raw value,
  // rather than opening the agent silently changing or blanking it.
  if (draft.model && !modelOptions.some((o) => o.value === draft.model)) {
    modelOptions.push({ value: draft.model, label: draft.model })
  }
  const effortOptions = EFFORTS.map((e2) => ({
    value: e2,
    label: e2 || t('library.agent.default'),
  }))

  return (
    <div className="flex flex-col gap-5">
      <Link
        to="/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('library.backToLibrary')}
      </Link>

      <PageHeader title={isNew ? t('library.newAgent') : draft.name || name} />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
            <Field>
              <FieldLabel htmlFor="agent-name">{t('library.agent.name')}</FieldLabel>
              <Input
                id="agent-name"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="tester"
              />
              <FieldDescription>
                {isNew ? t('library.agent.nameHint') : t('library.agent.renameHint')}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-role">{t('library.agent.role')}</FieldLabel>
              <Select
                items={roleOptions}
                value={draft.role}
                onValueChange={(v) => set('role', (v ?? 'subagent') as Draft['role'])}
              >
                <SelectTrigger id="agent-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex min-w-0 flex-col">
                        <span>{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t(`library.roleHint.${draft.role}`)}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-model">{t('library.agent.model')}</FieldLabel>
              <Select
                items={modelOptions}
                value={draft.model}
                onValueChange={(v) => set('model', v ?? '')}
              >
                <SelectTrigger id="agent-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex min-w-0 flex-col">
                        <span>{option.label}</span>
                        {option.description && (
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {models.data?.source === 'fallback' && (
                <FieldDescription>{t('library.agent.modelFallbackHint')}</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-effort">{t('library.agent.effort')}</FieldLabel>
              <Select
                items={effortOptions}
                value={draft.effort}
                onValueChange={(v) => set('effort', v ?? '')}
              >
                <SelectTrigger id="agent-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {effortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-max-turns">{t('library.agent.maxTurns')}</FieldLabel>
              <Input
                id="agent-max-turns"
                type="number"
                min={1}
                value={draft.maxTurns ?? ''}
                onChange={(e) => set('maxTurns', parseNumberInput(e))}
              />
              <FieldDescription>{t('library.agent.unlimited')}</FieldDescription>
            </Field>
          </div>

          {draft.role === 'orchestrator' && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="agent-team">{t('library.agent.team')}</FieldLabel>
                <FieldDescription>
                  {t(`library.agent.teamHint.${draft.team ? 'on' : 'off'}`)}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="agent-team"
                checked={draft.team}
                onCheckedChange={(checked) => set('team', checked)}
              />
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="agent-description">{t('library.agent.description')}</FieldLabel>
            <Input
              id="agent-description"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder={t('library.agent.descriptionPlaceholder')}
            />
            <FieldDescription>{t('library.agent.descriptionHint')}</FieldDescription>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="agent-restrict-tools">
                {t('library.agent.restrictTools')}
              </FieldLabel>
              <FieldDescription>{t('library.agent.toolsHint')}</FieldDescription>
            </FieldContent>
            <Checkbox
              id="agent-restrict-tools"
              checked={draft.restrictTools}
              onCheckedChange={(checked) => set('restrictTools', checked === true)}
            />
          </Field>
          {draft.restrictTools && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-3 gap-y-2">
              {AVAILABLE_TOOLS.map((tool) => (
                <Field key={tool} orientation="horizontal">
                  <FieldLabel htmlFor={`agent-tool-${tool}`} className="flex-1 font-normal">
                    {tool}
                  </FieldLabel>
                  <Checkbox
                    id={`agent-tool-${tool}`}
                    checked={draft.tools.includes(tool)}
                    onCheckedChange={(checked) =>
                      set(
                        'tools',
                        checked === true
                          ? [...draft.tools, tool]
                          : draft.tools.filter((x) => x !== tool),
                      )
                    }
                  />
                </Field>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Field>
        <FieldLabel htmlFor="agent-prompt">{t('library.agent.prompt')}</FieldLabel>
        <Textarea
          id="agent-prompt"
          className="field-sizing-fixed font-mono"
          rows={20}
          value={draft.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          spellCheck={false}
          placeholder={t('library.agent.promptPlaceholder')}
        />
        <FieldDescription>
          {draft.role === 'orchestrator'
            ? t('library.agent.promptHintOrchestrator')
            : t('library.agent.promptHint')}
        </FieldDescription>
      </Field>

      <div className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={busy || !draft.name || !draft.description || !draft.prompt}
            onClick={save}
          >
            {busy ? t('common.working') : t('common.save')}
          </Button>
          {!isNew && (
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
              {t('common.delete')}
            </Button>
          )}
        </div>
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
