import { Link } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Code, Loading } from '@/shared/components'
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui/empty'
import { Spinner } from '@/shared/ui/spinner'
import { type EditorOperation, useEditorStart, useEditorStatus } from '../hooks/use-editor'
import { EditorStartLog } from './editor-start-log'
import { RunningEditorsPanel } from './running-editors'

/**
 * The landing page for a session's own code-server — opened only as its own
 * browser tab (session-page.tsx's Editor link sets `target="_blank"`) and
 * rendered with no app shell around it at all (root-layout.tsx's
 * `isBareShellPath`). This component *is* the tab, start to finish: there is
 * no iframe here, and never will be — once the editor is confirmed running,
 * `window.location.replace` below hands the whole tab to code-server, which
 * draws its own chrome from there.
 *
 * What makes this a *launcher* rather than a dashboard like `DockerPage` is
 * the one thing it does that a dashboard never would: a `state: 'stopped'`
 * editor is started right here, without being asked twice. The only ways
 * anyone reaches this page are asking for the editor in the first place (the
 * session header's link) or the backend's own proxy bouncing a stale tab
 * back here once the container has idled out — in both cases, stopped is not
 * a state to explain, it's a state to fix.
 */
export function EditorLauncher({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useTranslation()
  const status = useEditorStatus(projectId, sessionId)
  const start = useEditorStart(projectId, sessionId)
  const data = status.data

  // Captures the tab's own title exactly once, before this component ever
  // sets one, and restores it exactly once on unmount — split from the
  // effect below that keeps the title in step with the current state, since
  // that one runs on every state change and must never mistake "the title a
  // moment ago" for "the title this tab found here first". Restored so that
  // leaving via the "back to session" link (an in-app navigation, not a full
  // reload) does not strand a launcher title on a page that never asked for
  // one.
  useEffect(() => {
    const previous = document.title
    return () => {
      document.title = previous
    }
  }, [])

  // Fires the first time this tab sees the editor stopped, and never again:
  // `autoStarted` is a ref rather than, say, a check against `data` itself,
  // because it has to survive both StrictMode's mount→cleanup→mount and
  // every refetch afterwards — `useEditorStatus` keeps polling, and a
  // refetch that lands back on 'stopped' (the failure branch below) must
  // read as "already tried," not "stopped again, try again." A failed
  // attempt is never retried on its own; only the reader's own Retry click
  // calls `start.mutate` a second time.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (data?.state !== 'stopped' || !data.enabled || !data.daemon.available) return
    if (autoStarted.current) return
    autoStarted.current = true
    start.mutate({ path: { id: projectId, sessionId } })
  }, [data, start, projectId, sessionId])

  // The one state with nothing of its own to render: the moment the
  // container is confirmed running, this tab leaves the app for good.
  // `replace`, not `assign` — Back has to land wherever the reader was
  // *before* this tab opened the editor, not on this launcher.
  useEffect(() => {
    if (data?.state === 'running') window.location.replace(data.proxyPath)
  }, [data])

  const retry = () => start.mutate({ path: { id: projectId, sessionId } })

  // This tab's own last `start.mutate` call — an auto-start or a manual
  // Retry/Restart click — read once, up here, because it can be the thing
  // that turns *any* start-triggering state's page from silent into
  // explained: 'unresponsive' (Restart), 'stopped' with a stale failed
  // operation, or 'stopped' still waiting on the very attempt that produced
  // this error. Takes priority over a stale `operation.status === 'failed'`
  // wherever both are read below — it is the more recent of the two by
  // definition, since it is what a click just produced.
  const startError = start.isError
    ? apiErrorMessage(start.error, t('editor.errors.startFailed'))
    : null

  const backToSession = (
    <Link
      to="/projects/$projectId/sessions/$sessionId"
      params={{ projectId, sessionId }}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {t('editor.backToSession')}
    </Link>
  )

  let body: ReactNode
  // The tab's own title, set to match whatever `body` below is showing.
  // Loading, starting (including 'stopped' still waiting on the auto-start
  // effect above) and running all read as the one `editor.launcher.opening`
  // copy — the operator's own complaint was two near-identical "starting…"
  // labels in quick succession, so this is deliberately a single string that
  // never changes across that whole sequence, not three ways of saying the
  // same thing. Only a state with something to actually tell the reader
  // (load failure, disabled, daemon down, unresponsive, a failed start) gets
  // its own title.
  let title: string
  if (status.isPending) {
    title = t('editor.launcher.opening')
    body = <Loading label={t('editor.launcher.opening')} block />
  } else if (status.isError || !data) {
    // Covers every shape of GET failure worth telling apart here (a shared
    // checkout with no worktree of its own, a session that no longer
    // exists, a worktree removed from disk) with the one thing they share:
    // there is nothing this page can do about any of them itself.
    title = t('editor.loadFailed')
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>
            {apiErrorMessage(status.error, t('editor.loadFailed'))}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{backToSession}</EmptyContent>
      </Empty>
    )
  } else if (!data.enabled) {
    title = t('editor.empty.title')
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{t('editor.empty.description')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{backToSession}</EmptyContent>
      </Empty>
    )
  } else if (!data.daemon.cliInstalled || !data.daemon.available) {
    title = data.daemon.cliInstalled
      ? t('editor.daemon.unavailableTitle')
      : t('editor.daemon.notInstalledTitle')
    body = (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <p>
                {data.daemon.cliInstalled
                  ? t('editor.daemon.unavailable')
                  : t('editor.daemon.notInstalled')}
              </p>
              {data.daemon.error && (
                <Code block wrap>
                  {data.daemon.error}
                </Code>
              )}
            </div>
          </AlertDescription>
        </Alert>
        <div>{backToSession}</div>
      </div>
    )
  } else if (data.state === 'running') {
    // Transient — the effect above is already replacing this document.
    title = t('editor.launcher.opening')
    body = <Loading label={t('editor.launcher.opening')} block />
  } else if (data.state === 'unresponsive') {
    title = t('editor.state.unresponsiveTitle')
    const actions = (
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => window.location.assign(data.proxyPath)}>
          {t('editor.launcher.openAnyway')}
        </Button>
        <Button type="button" variant="outline" disabled={start.isPending} onClick={retry}>
          {start.isPending && <Spinner data-icon="inline-start" />}
          {t('editor.restart')}
        </Button>
      </div>
    )
    // Once there is a start error to show, this becomes an active problem
    // rather than a quiet dead end — an `Alert` for the message, with
    // `RunningEditorsPanel` (turns a cap failure into something actionable;
    // see its own header comment) and the actions underneath. Restart stays
    // available either way, so a 409 (the running-editor cap) or any other
    // rejected Restart is never a dead end.
    body = startError ? (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              <p>{t('editor.state.unresponsiveBody')}</p>
              <p>{startError}</p>
            </div>
          </AlertDescription>
        </Alert>
        <RunningEditorsPanel onSlotFreed={retry} />
        {actions}
      </div>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{t('editor.state.unresponsiveBody')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{actions}</EmptyContent>
      </Empty>
    )
  } else if (data.state === 'starting') {
    title = t('editor.launcher.opening')
    body = <StartingPanel operation={data.operation} />
  } else {
    // 'stopped'. Either the auto-start effect above just fired (or is about
    // to — effects run after this render commits) and the log will start
    // filling in once that POST resolves, or the last attempt — this page's
    // own auto-start, or a manual Retry — already failed and is waiting on
    // another click.
    const opError = data.operation?.status === 'failed' ? data.operation.error : null
    const failure = startError ?? opError

    title = failure ? t('editor.operationFailed') : t('editor.launcher.opening')
    // Same `RunningEditorsPanel` as the unresponsive branch above — mounted
    // here too because a cap failure reaches this branch a second way: the
    // POST itself can succeed (200, `startError` stays null) while the
    // worker's own cap check fails the operation it queued, which lands here
    // as an ordinary `operation.status === 'failed'`.
    body = failure ? (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t('editor.operationFailed')}</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
        <div>
          <Button type="button" disabled={start.isPending} onClick={retry}>
            {start.isPending && <Spinner data-icon="inline-start" />}
            {t('editor.launcher.retry')}
          </Button>
        </div>
        {data.operation && <EditorStartLog operation={data.operation} />}
        <RunningEditorsPanel onSlotFreed={retry} />
      </div>
    ) : (
      <StartingPanel operation={data.operation} />
    )
  }

  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-2xl flex-col gap-4">{body}</div>
    </div>
  )
}

// A cold image pull is the only reason a start ever takes long enough to
// need the note and log below — everything else settles within a couple of
// polling ticks (`useEditorStatus`'s own 2s interval while 'starting'). Held
// back this long so the warm-start path (the common one) shows nothing but
// the spinner: revealing the extras immediately was the operator's own
// complaint, a "Starting…" label followed a beat later by a second,
// near-identical block of copy.
const START_DETAILS_DELAY_MS = 3000

/**
 * The "something is happening, hang on" content — shared between a session
 * actually reported as `state: 'starting'` and a `'stopped'` one this page
 * just told to start (the auto-start effect above): both are the same wait,
 * just reached through different doors.
 *
 * Renders nothing but the spinner at first, on purpose: a quick, warm start
 * never shows the note or the log at all. Only once the timer below fires
 * (this attempt is still running after `START_DETAILS_DELAY_MS`) does the
 * note and log get appended beneath it; that is a single, deliberate shift,
 * not the back-and-forth the fix here is about, and it never reverses —
 * `showDetails` only ever goes false→true for the life of this component.
 */
function StartingPanel({ operation }: { operation: EditorOperation | null }) {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowDetails(true), START_DETAILS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <Loading label={t('editor.launcher.opening')} block />
      {showDetails && (
        <>
          <p className="text-center text-sm text-muted-foreground">
            {t('editor.state.startingNote')}
          </p>
          <EditorStartLog operation={operation} />
        </>
      )}
    </div>
  )
}
