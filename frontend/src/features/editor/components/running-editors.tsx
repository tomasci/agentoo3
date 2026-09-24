import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import type { GetApiEditorsStatus200 } from '@/shared/api/generated/types/GetApiEditors'
import { Code, ConfirmDialog, StatusBadge, type Tone, toast } from '@/shared/components'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Item, ItemActions, ItemContent, ItemGroup, ItemHeader } from '@/shared/ui/item'
import { Spinner } from '@/shared/ui/spinner'
import { useRunningEditors, useStopRunningEditor } from '../hooks/use-running-editors'
import { formatLastActive } from './format-last-active'

type RunningEditor = GetApiEditorsStatus200['editors'][number]
type Health = RunningEditor['health']

const HEALTH_TONE: Record<Health, Tone> = {
  // A connected tab is the normal, working state — not a warning.
  'in-use': 'success',
  // Reachable but nobody is looking at it: the prime candidate to free, so it
  // reads as worth a second look rather than merely informational.
  idle: 'warning',
  // Did not answer its health check at all — an actual problem.
  unresponsive: 'danger',
}
const HEALTH_LABEL_KEY: Record<Health, string> = {
  'in-use': 'inUse',
  idle: 'idle',
  unresponsive: 'unresponsive',
}

/**
 * "Who is holding the running-editor cap" — shown under the launcher's own
 * failure message once a start has actually failed there (editor-launcher.tsx
 * decides *when*; this decides *whether there is anything to show*, since a
 * cap failure can also be caused by something this install cannot list at
 * all — another agentoo install sharing the same docker daemon, or an orphan
 * a few minutes from being reaped).
 *
 * Deliberately mounted only inside that failure view, never earlier: the
 * "mount is the on/off switch" idiom `useRunningEditors` itself documents is
 * what starts (and later stops) the polling this panel needs to keep
 * "In use"/"Idle" current without polling `/api/editors` on every ordinary
 * launcher visit.
 */
export function RunningEditorsPanel({ onSlotFreed }: { onSlotFreed: () => void }) {
  const { t } = useTranslation()
  const query = useRunningEditors()
  const data = query.data

  // Nothing to add yet (still loading, or the GET itself failed) and nothing
  // to add ever (the cap has not actually been reached, or the feature is
  // off) — either way, the launcher's own error message already stands on
  // its own.
  if (!data?.enabled || data.running < data.cap) return null

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">
        {t('editor.runningPanel.heading', { running: data.running, cap: data.cap })}
      </h3>
      {data.editors.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('editor.runningPanel.unlisted')}</p>
      ) : (
        <ItemGroup>
          {data.editors.map((editor) => (
            <EditorRow
              key={`${editor.projectId}:${editor.sessionId}`}
              editor={editor}
              onStopped={onSlotFreed}
            />
          ))}
        </ItemGroup>
      )}
      {data.otherInstallsRunning > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('editor.runningPanel.otherInstalls', { count: data.otherInstallsRunning })}
        </p>
      )}
    </div>
  )
}

function EditorRow({ editor, onStopped }: { editor: RunningEditor; onStopped: () => void }) {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const stop = useStopRunningEditor()

  const doStop = () =>
    stop.mutate(
      { path: { id: editor.projectId, sessionId: editor.sessionId } },
      {
        onSuccess: () => {
          setConfirmOpen(false)
          onStopped()
        },
        onError: (error) => {
          setConfirmOpen(false)
          toast.add({ title: apiErrorMessage(error, t('editor.errors.stopFailed')), type: 'error' })
        },
      },
    )

  // An open tab means someone else is looking at this editor right now —
  // that is the one case worth a confirmation, since Stop closes it out from
  // under them. Idle and unresponsive rows have nobody to surprise.
  const requestStop = () => (editor.health === 'in-use' ? setConfirmOpen(true) : doStop())

  const sessionTitle =
    editor.sessionTitle ?? t('sessions.untitled', { id: editor.sessionId.slice(0, 8) })

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemHeader>
          <span className="font-semibold">{editor.projectName}</span>
          <span className="text-muted-foreground">{sessionTitle}</span>
        </ItemHeader>
        <div className="flex flex-wrap items-center gap-2">
          {editor.branch && <Code>{editor.branch}</Code>}
          <StatusBadge tone={HEALTH_TONE[editor.health]}>
            {t(`editor.runningPanel.health.${HEALTH_LABEL_KEY[editor.health]}`)}
          </StatusBadge>
          {editor.lastActiveAt && (
            <span className="text-xs text-muted-foreground">
              {t('editor.runningPanel.lastActive', {
                time: formatLastActive(editor.lastActiveAt),
              })}
            </span>
          )}
        </div>
      </ItemContent>
      <ItemActions>
        <Link
          to="/projects/$projectId/sessions/$sessionId/editor"
          params={{ projectId: editor.projectId, sessionId: editor.sessionId }}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('editor.runningPanel.open')}
        </Link>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={stop.isPending}
          onClick={requestStop}
        >
          {stop.isPending && <Spinner data-icon="inline-start" />}
          {t('editor.runningPanel.stop')}
        </Button>
      </ItemActions>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('editor.runningPanel.confirmStopTitle')}
        description={t('editor.runningPanel.confirmStopBody')}
        confirmLabel={t('editor.runningPanel.stop')}
        busy={stop.isPending}
        onConfirm={doStop}
      />
    </Item>
  )
}
