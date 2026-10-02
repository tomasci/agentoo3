import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon, CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import {
  Code,
  ConfirmDialog,
  type DefinitionItem,
  DefinitionList,
  Loading,
  Markdown,
  PageHeader,
  StatusBadge,
  toast,
} from '@/shared/components'
import { Alert, AlertDescription } from '@/shared/ui/alert'
import { Button, buttonVariants } from '@/shared/ui/button'
import {
  type LibrarySuggestion,
  useApplySuggestion,
  useDeleteSuggestion,
  useRejectSuggestion,
  useSuggestion,
} from '../hooks/use-learning'
import { formatDateTime } from '../lib/format'
import { SuggestionDiff } from './suggestion-diff'

const STATUS_TONE = { pending: 'neutral', applied: 'success', rejected: 'danger' } as const

function itemRouteFor(kind: LibrarySuggestion['kind']) {
  return kind === 'agent' ? '/library/agents/$name' : '/library/skills/$name'
}

/** The fields a `create` suggestion's structured `proposed` body is worth
 *  showing before the full file — `proposed` is untyped on the wire (see
 *  `LibrarySuggestion`'s own doc comment), so every field is read
 *  defensively and only shown when it is actually present. */
function proposedFields(
  suggestion: LibrarySuggestion,
  t: (key: string) => string,
): DefinitionItem[] {
  const proposed = suggestion.proposed as Record<string, unknown>
  const items: DefinitionItem[] = []
  if (typeof proposed.description === 'string') {
    items.push({
      id: 'description',
      term: t('library.agent.description'),
      description: proposed.description,
    })
  }
  if (suggestion.kind === 'agent') {
    if (typeof proposed.role === 'string') {
      items.push({
        id: 'role',
        term: t('library.agent.role'),
        description: t(`library.role.${proposed.role}`),
      })
    }
    if (typeof proposed.model === 'string' && proposed.model) {
      items.push({ id: 'model', term: t('library.agent.model'), description: proposed.model })
    }
    if (typeof proposed.effort === 'string' && proposed.effort) {
      items.push({ id: 'effort', term: t('library.agent.effort'), description: proposed.effort })
    }
    if (typeof proposed.maxTurns === 'number') {
      items.push({
        id: 'maxTurns',
        term: t('library.agent.maxTurns'),
        description: String(proposed.maxTurns),
      })
    }
    if (Array.isArray(proposed.tools)) {
      items.push({
        id: 'tools',
        term: t('library.agent.restrictTools'),
        description: (proposed.tools as unknown[]).map(String).join(', ') || '—',
      })
    }
  }
  return items
}

function CreatePreview({ suggestion }: { suggestion: LibrarySuggestion }) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)
  const proposed = suggestion.proposed as Record<string, unknown>
  const body =
    suggestion.kind === 'agent' ? String(proposed.prompt ?? '') : String(proposed.body ?? '')

  return (
    <div className="flex flex-col gap-4">
      <DefinitionList items={proposedFields(suggestion, t)} />
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {showRaw
            ? t('library.suggestions.detail.rawMarkdown')
            : t('library.suggestions.detail.preview')}
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowRaw((s) => !s)}>
          {showRaw
            ? t('library.suggestions.detail.preview')
            : t('library.suggestions.detail.rawMarkdown')}
        </Button>
      </div>
      {showRaw ? (
        <Code block wrap>
          {suggestion.proposedMarkdown}
        </Code>
      ) : (
        <Markdown>{body}</Markdown>
      )}
    </div>
  )
}

export function SuggestionReviewPage({ id }: { id: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: suggestion, isPending, isError, error } = useSuggestion(id)
  const apply = useApplySuggestion(id)
  const reject = useRejectSuggestion(id)
  const remove = useDeleteSuggestion()
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirmApply, setConfirmApply] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const BackLink = () => (
    <Link
      to="/library/suggested"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      {t('library.tabs.suggested')}
    </Link>
  )

  if (isPending) return <Loading label={t('common.loading')} block />

  if (isError || !suggestion) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {apiErrorMessage(error, t('library.suggestions.detail.loadFailed'))}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const itemRoute = itemRouteFor(suggestion.kind)
  const targetMissing = suggestion.action === 'modify' && suggestion.currentMarkdown === null
  // 'create': targetExists is false unless the name is now taken — see
  // LibrarySuggestionSummary's own doc comment.
  const targetTaken = suggestion.action === 'create' && suggestion.targetExists
  const canApply = suggestion.status === 'pending' && !targetMissing && !targetTaken
  const isPendingModify = suggestion.action === 'modify' && suggestion.status === 'pending'
  // Applied or rejected: the suggestion has already been decided, so the
  // honest comparison is baseMarkdown (the target's own state at proposal
  // time) against proposedMarkdown (what was proposed/applied) — not the
  // live item, which `stale`'s "applying replaces it" wording does not fit
  // (nothing is about to be applied) and which may since have moved on to
  // changes this suggestion never touched at all.
  const isDecidedModify = suggestion.action === 'modify' && suggestion.status !== 'pending'

  return (
    <div className="flex flex-col gap-5">
      <BackLink />

      <PageHeader
        title={suggestion.title}
        // `PageHeader`'s own `eyebrow` slot renders inside a `<p>` — a `<span>`
        // row of badges nests there validly, a `<div>` would not.
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge tone={suggestion.kind === 'agent' ? 'accent' : 'neutral'}>
              {t(`library.suggestions.kind.${suggestion.kind}`)}
            </StatusBadge>
            <StatusBadge tone={suggestion.action === 'create' ? 'accent' : 'neutral'}>
              {t(`library.suggestions.action.${suggestion.action}`)}
            </StatusBadge>
            <StatusBadge tone={STATUS_TONE[suggestion.status]}>
              {t(`library.suggestions.detail.status.${suggestion.status}`)}
            </StatusBadge>
          </span>
        }
        description={suggestion.name}
      />

      <div className="flex flex-col gap-2">
        <Markdown compact>{suggestion.rationale}</Markdown>
        {suggestion.sourceSessions.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">{t('library.suggestions.sourceSessions')}</span>
            {suggestion.sourceSessions.map((session) => (
              <Link
                key={session.id}
                to="/projects/$projectId/sessions/$sessionId"
                params={{ projectId: session.projectId, sessionId: session.id }}
                className="text-primary underline underline-offset-4 hover:no-underline"
              >
                {session.title ?? session.projectName}
              </Link>
            ))}
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {t('library.suggestions.createdAt', { date: formatDateTime(suggestion.createdAt) })}
        </span>
      </div>

      {suggestion.status === 'pending' && targetMissing && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{t('library.suggestions.detail.targetMissingBody')}</AlertDescription>
        </Alert>
      )}
      {suggestion.status === 'pending' && targetTaken && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            {t('library.suggestions.detail.targetTakenBody', {
              name: suggestion.name,
              kind: t(`library.suggestions.kindLower.${suggestion.kind}`),
            })}
          </AlertDescription>
        </Alert>
      )}
      {/* `stale` only means something for a suggestion still awaiting a
          decision — the backend also only reports it true for a pending
          modify, but this guard holds even if that ever slips. */}
      {isPendingModify && !targetMissing && suggestion.stale && (
        <Alert>
          <CircleAlertIcon />
          <AlertDescription>{t('library.suggestions.detail.staleBody')}</AlertDescription>
        </Alert>
      )}

      {suggestion.action === 'modify' ? (
        <>
          {isPendingModify && suggestion.currentMarkdown !== null && (
            <SuggestionDiff
              before={suggestion.currentMarkdown}
              after={suggestion.proposedMarkdown}
            />
          )}
          {isDecidedModify && suggestion.baseMarkdown !== null && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {suggestion.status === 'applied'
                  ? t('library.suggestions.detail.diffCaptionApplied')
                  : t('library.suggestions.detail.diffCaptionRejected')}
              </p>
              <SuggestionDiff
                before={suggestion.baseMarkdown}
                after={suggestion.proposedMarkdown}
              />
            </div>
          )}
        </>
      ) : (
        <CreatePreview suggestion={suggestion} />
      )}

      {serverError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      {suggestion.status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!canApply} onClick={() => setConfirmApply(true)}>
            {t('library.suggestions.detail.apply')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setConfirmReject(true)}>
            {t('library.suggestions.reject')}
          </Button>
        </div>
      )}

      {suggestion.status === 'applied' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {suggestion.appliedVersion !== null && (
            <span>
              {t('library.suggestions.detail.appliedVersion', {
                version: suggestion.appliedVersion,
              })}
            </span>
          )}
          <Link
            to={itemRoute}
            params={{ name: suggestion.name }}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('library.suggestions.detail.viewInLibrary')}
          </Link>
        </div>
      )}

      {suggestion.status === 'rejected' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
            {t('library.suggestions.deletePermanently')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmApply}
        onOpenChange={setConfirmApply}
        title={
          suggestion.action === 'modify'
            ? t('library.suggestions.detail.applyTitleModify')
            : t('library.suggestions.detail.applyTitleCreate')
        }
        description={
          suggestion.action === 'modify'
            ? t('library.suggestions.detail.applyConfirmModify', { name: suggestion.name })
            : t('library.suggestions.detail.applyConfirmCreate', {
                kind: t(`library.suggestions.kindLower.${suggestion.kind}`),
                name: suggestion.name,
              })
        }
        destructive={false}
        confirmLabel={t('library.suggestions.detail.apply')}
        busy={apply.isPending}
        onConfirm={() => {
          setServerError(null)
          apply.mutate(
            { path: { id }, body: { expectedCurrentHash: suggestion.currentHash } },
            {
              onSuccess: (data) => {
                setConfirmApply(false)
                toast.add({ title: t('library.suggestions.detail.applied'), type: 'success' })
                void navigate({ to: itemRouteFor(data.kind), params: { name: data.name } })
              },
              onError: (e) => {
                setConfirmApply(false)
                setServerError(apiErrorMessage(e, t('library.suggestions.detail.applyFailed')))
              },
            },
          )
        }}
      />

      <ConfirmDialog
        open={confirmReject}
        onOpenChange={setConfirmReject}
        title={t('library.suggestions.rejectTitle')}
        description={t('library.suggestions.rejectConfirm', { title: suggestion.title })}
        confirmLabel={t('library.suggestions.reject')}
        busy={reject.isPending}
        onConfirm={() => {
          setServerError(null)
          reject.mutate(
            { path: { id } },
            {
              onSuccess: () => {
                toast.add({ title: t('library.suggestions.rejected'), type: 'success' })
                void navigate({ to: '/library/suggested' })
              },
              onError: (e) => {
                setConfirmReject(false)
                setServerError(apiErrorMessage(e, t('library.suggestions.rejectFailed')))
              },
            },
          )
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('library.suggestions.deleteTitle')}
        description={t('library.suggestions.deleteConfirm', { title: suggestion.title })}
        confirmLabel={t('library.suggestions.deletePermanently')}
        busy={remove.isPending}
        onConfirm={() => {
          setServerError(null)
          remove.mutate(
            { path: { id } },
            {
              onSuccess: () => void navigate({ to: '/library/rejected' }),
              onError: (e) => {
                setConfirmDelete(false)
                setServerError(apiErrorMessage(e, t('library.suggestions.deleteFailed')))
              },
            },
          )
        }}
      />
    </div>
  )
}
