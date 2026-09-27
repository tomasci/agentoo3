import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '@/features/library'
import { useProjects } from '@/features/projects'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Spinner } from '@/shared/ui/spinner'
import { useCreateSession } from '../hooks/use-sessions'

const NEW_SESSION_FORM_ID = 'new-session-form'

/**
 * The "New session" form, moved into its own dialog off the sessions page —
 * it used to sit permanently open above the list. Kept as controlled state
 * rather than react-hook-form: the fields, their hints and the request body
 * they build are unchanged from before, and there is nothing here a resolver
 * would buy back.
 */
export function NewSessionDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { data: projects } = useProjects()
  // `isSuccess` (not just `agents`), so a query still loading or one that
  // failed reads as "unknown", not "empty" — otherwise `agents` is
  // `undefined` in both cases, `orchestrators` below comes out `[]` either
  // way, and the dialog would flash "No orchestrator agents in the library
  // yet…" on every open, real library or not, until the request actually
  // settles.
  const { data: agents, isSuccess: agentsLoaded } = useAgents()
  const create = useCreateSession(projectId)

  const [title, setTitle] = useState('')
  const [orchestrator, setOrchestrator] = useState('')
  // Only raised on a submit attempted with nothing chosen — not on every
  // keystroke — and cleared the moment a choice is made (the Select's own
  // `onValueChange` below) or the form resets.
  const [orchestratorError, setOrchestratorError] = useState(false)
  const [budget, setBudget] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  // This component stays mounted across a close (only the Dialog's own
  // portal unmounts), so a `create.mutate()` still in flight can settle into
  // a *later* open — `generationRef` (bumped by `close()` below) plus the
  // `myGeneration` capture in `onCreate` is what tells a callback its own
  // attempt is stale before it touches the dialog.
  const generationRef = useRef(0)

  const titleId = useId()
  const baseBranchId = useId()
  const orchestratorId = useId()
  const orchestratorMessageId = useId()
  const budgetId = useId()

  const project = (projects ?? []).find((p) => p.id === projectId)

  // Orchestrator is now required — the backend rejects a create with none —
  // so the list is only ever the library's own orchestrators, chosen through
  // the trigger's placeholder rather than an explicit "(none)" item a reader
  // could pick their way back to.
  const orchestrators = (agents ?? []).filter((a) => a.role === 'orchestrator')
  // Just the name in the trigger's own label: a long unbroken orchestrator
  // name is demoted to the item's own description line instead, shown only
  // inside the open list.
  const orchestratorOptions = orchestrators.map((a) => ({
    value: a.name,
    label: a.name,
    description: a.description,
  }))

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

  // A fresh open must never show the previous attempt's server error, and a
  // cancelled dialog must not leave a half-filled form behind for whoever
  // opens it next — both close together here rather than at each call site.
  const resetForm = () => {
    setTitle('')
    setOrchestrator('')
    setOrchestratorError(false)
    setBudget('')
    setBaseBranch('')
    setFormError(null)
  }

  // The dialog's only two ways to close — Cancel/Escape/overlay (the Dialog's
  // own onOpenChange below) and a successful create (onCreate's onSuccess) —
  // go through this one helper, so they can't drift apart.
  const close = () => {
    generationRef.current++
    resetForm()
    onOpenChange(false)
  }

  const onCreate = () => {
    // Nothing is sent without an orchestrator — the backend requires one on
    // every create — so a submit with none chosen stops here, in an inline
    // field error, rather than round-tripping to learn the same thing.
    if (!orchestrator) {
      setOrchestratorError(true)
      return
    }
    setFormError(null)
    const myGeneration = generationRef.current
    create.mutate(
      {
        path: { id: projectId },
        body: {
          ...(title.trim() ? { title: title.trim() } : {}),
          orchestrator,
          ...(budget ? { maxBudgetUsd: Number(budget) } : {}),
          ...(trimmedBaseBranch ? { baseBranch: trimmedBaseBranch } : {}),
        },
      },
      {
        onSuccess: () => {
          if (generationRef.current !== myGeneration) return
          close()
        },
        onError: (e) => {
          if (generationRef.current !== myGeneration) return
          setFormError(apiErrorMessage(e, t('sessions.createFailed')))
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(next)
        else close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sessions.form.heading')}</DialogTitle>
        </DialogHeader>

        <form
          id={NEW_SESSION_FORM_ID}
          onSubmit={(e) => {
            e.preventDefault()
            onCreate()
          }}
          className="flex flex-col gap-3"
        >
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

          <Field data-invalid={orchestratorError || undefined}>
            <FieldLabel htmlFor={orchestratorId}>{t('sessions.form.orchestrator')}</FieldLabel>
            <Select
              items={orchestratorOptions}
              value={orchestrator || null}
              onValueChange={(value) => {
                setOrchestrator(value ?? '')
                setOrchestratorError(false)
              }}
            >
              <SelectTrigger
                id={orchestratorId}
                className="w-full"
                aria-invalid={orchestratorError}
                aria-describedby={orchestratorMessageId}
              >
                <SelectValue placeholder={t('sessions.form.orchestratorPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {orchestratorOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex flex-col">
                      <span>{option.label}</span>
                      {option.description && (
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {orchestratorError ? (
              <FieldError id={orchestratorMessageId}>
                {t('sessions.form.orchestratorRequired')}
              </FieldError>
            ) : (
              <FieldDescription id={orchestratorMessageId}>
                {orchestrators.length === 0 && agentsLoaded
                  ? t('sessions.form.orchestratorEmpty')
                  : t('sessions.form.orchestratorHint')}
              </FieldDescription>
            )}
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

          {project && project.status !== 'ready' && (
            <span className="text-xs text-muted-foreground">{t('sessions.form.notReady')}</span>
          )}

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('common.cancel')}
          </DialogClose>
          <Button
            type="submit"
            form={NEW_SESSION_FORM_ID}
            disabled={create.isPending || project?.status !== 'ready' || orchestrators.length === 0}
          >
            {create.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {create.isPending ? t('sessions.form.creating') : t('sessions.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
