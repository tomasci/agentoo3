import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorMessage } from '@/features/projects/lib/api-error'
import { Alert, Button, Code, EmptyState, Inline, Spinner, Stack } from '@/shared/ui'
import { type EditorOperation, useEditorStart, useEditorStatus } from '../hooks/use-editor'
import styles from './editor-launcher.module.scss'
import { EditorStartLog } from './editor-start-log'

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
    <Button asChild variant="secondary" size="sm">
      <Link to="/projects/$projectId/sessions/$sessionId" params={{ projectId, sessionId }}>
        {t('editor.backToSession')}
      </Link>
    </Button>
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
    body = <Spinner label={t('editor.launcher.opening')} block />
  } else if (status.isError || !data) {
    // Covers every shape of GET failure worth telling apart here (a shared
    // checkout with no worktree of its own, a session that no longer
    // exists, a worktree removed from disk) with the one thing they share:
    // there is nothing this page can do about any of them itself.
    title = t('editor.loadFailed')
    body = (
      <EmptyState
        title={t('editor.loadFailed')}
        description={apiErrorMessage(status.error, t('editor.loadFailed'))}
        action={backToSession}
      />
    )
  } else if (!data.enabled) {
    title = t('editor.empty.title')
    body = (
      <EmptyState
        title={t('editor.empty.title')}
        description={t('editor.empty.description')}
        action={backToSession}
      />
    )
  } else if (!data.daemon.cliInstalled || !data.daemon.available) {
    // `Alert`, not `EmptyState`: the daemon's own raw error is block content
    // (a `<Code block>`, which renders a `<pre>`) and `EmptyState` wraps its
    // `description` in a `<p>` — nesting a `<pre>` (or another block element)
    // inside a `<p>` is invalid HTML, which is exactly what this used to do
    // before it was an `Alert`, whose `children` sit in a plain `<div>`.
    title = data.daemon.cliInstalled
      ? t('editor.daemon.unavailableTitle')
      : t('editor.daemon.notInstalledTitle')
    body = (
      <Alert tone="danger" title={title} action={backToSession}>
        <Stack gap={2}>
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
        </Stack>
      </Alert>
    )
  } else if (data.state === 'running') {
    // Transient — the effect above is already replacing this document.
    title = t('editor.launcher.opening')
    body = <Spinner label={t('editor.launcher.opening')} block />
  } else if (data.state === 'unresponsive') {
    title = t('editor.state.unresponsiveTitle')
    const actions = (
      <Inline gap={2}>
        <Button type="button" onClick={() => window.location.assign(data.proxyPath)}>
          {t('editor.launcher.openAnyway')}
        </Button>
        <Button type="button" variant="secondary" loading={start.isPending} onClick={retry}>
          {t('editor.restart')}
        </Button>
      </Inline>
    )
    // `Alert`, not `EmptyState`, once there is a start error to show: the
    // same nesting problem as the daemon branch above — a second `<p>` passed
    // as `EmptyState`'s `description` would land inside the one it already
    // wraps its own description in. Restart stays available either way, so a
    // 409 (the running-editor cap) or any other rejected Restart is never a
    // dead end.
    body = startError ? (
      <Alert tone="danger" title={title} action={actions}>
        <Stack gap={3}>
          <p>{t('editor.state.unresponsiveBody')}</p>
          <p>{startError}</p>
        </Stack>
      </Alert>
    ) : (
      <EmptyState title={title} description={t('editor.state.unresponsiveBody')} action={actions} />
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
    body = failure ? (
      <Alert
        tone="danger"
        title={t('editor.operationFailed')}
        action={
          <Button type="button" loading={start.isPending} onClick={retry}>
            {t('editor.launcher.retry')}
          </Button>
        }
      >
        <Stack gap={3}>
          <p>{failure}</p>
          {data.operation && <EditorStartLog operation={data.operation} />}
        </Stack>
      </Alert>
    ) : (
      <StartingPanel operation={data.operation} />
    )
  }

  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className={styles.page}>
      <div className={styles.panel}>{body}</div>
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
 * never shows the note or the log at all, and the spinner's own row is then
 * byte-for-byte the same markup the loading and running states render, so
 * `.panel`'s height — and with it, the spinner's centred position within the
 * full-viewport `.page` — never moves between those three states. Only once
 * the timer below fires (this attempt is still running after
 * `START_DETAILS_DELAY_MS`) does the note and log get appended beneath it;
 * that is a single, deliberate shift, not the back-and-forth the fix here is
 * about, and it never reverses — `showDetails` only ever goes false→true for
 * the life of this component.
 */
function StartingPanel({ operation }: { operation: EditorOperation | null }) {
  const { t } = useTranslation()
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowDetails(true), START_DETAILS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <Stack gap={4}>
      <Spinner label={t('editor.launcher.opening')} block />
      {showDetails && (
        <>
          <p className={styles.note}>{t('editor.state.startingNote')}</p>
          <EditorStartLog operation={operation} />
        </>
      )}
    </Stack>
  )
}
